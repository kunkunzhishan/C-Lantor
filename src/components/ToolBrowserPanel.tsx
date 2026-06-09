import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, MonitorSmartphone, Plus, Smartphone, X } from "lucide-react";
import {
  closeEmbeddedToolBrowser,
  goBackEmbeddedToolBrowser,
  goForwardEmbeddedToolBrowser,
  isTauriRuntime,
  openEmbeddedToolBrowser,
  openExternalUrl,
  setEmbeddedToolBrowserBounds,
  subscribeToolBrowserTabOpen,
  toolBrowserTargetFromHref,
  type EmbeddedToolBrowserBounds,
} from "../apiClient";

type ToolBrowserDisplayMode = "responsive" | "desktop-fit";

const TOOL_BROWSER_DISPLAY_MODE_STORAGE_KEY = "lantor.toolBrowser.displayMode";
const TOOL_BROWSER_DESKTOP_VIEWPORT_WIDTH = 1180;
const NATIVE_WEBVIEW_EDGE_INSET = 2;
const NATIVE_WEBVIEW_TOP_GUARD = 12;
const NATIVE_WEBVIEW_BOUNDS_EPSILON = 1;
const NATIVE_WEBVIEW_ZOOM_EPSILON = 0.005;

type ToolBrowserPanelProps = {
  target: string | null;
  onTargetChange: (target: string) => void;
  onClose: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
};

type ToolBrowserTab = {
  id: string;
  url: string;
  host: string;
};

type NativeBoundsSyncReason = "resize" | "display-mode" | "tabs";

type NativeBoundsSyncStats = {
  skipped: number;
  sent: number;
  lastReason: NativeBoundsSyncReason | null;
};

function targetHost(target: string) {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

function storedDisplayMode(): ToolBrowserDisplayMode {
  try {
    return window.localStorage.getItem(TOOL_BROWSER_DISPLAY_MODE_STORAGE_KEY) === "desktop-fit"
      ? "desktop-fit"
      : "responsive";
  } catch {
    return "responsive";
  }
}

function boundsChanged(previous: EmbeddedToolBrowserBounds | null, next: EmbeddedToolBrowserBounds) {
  if (!previous) return true;
  return (
    Math.abs(previous.x - next.x) >= NATIVE_WEBVIEW_BOUNDS_EPSILON ||
    Math.abs(previous.y - next.y) >= NATIVE_WEBVIEW_BOUNDS_EPSILON ||
    Math.abs(previous.width - next.width) >= NATIVE_WEBVIEW_BOUNDS_EPSILON ||
    Math.abs(previous.height - next.height) >= NATIVE_WEBVIEW_BOUNDS_EPSILON ||
    Math.abs((previous.zoom ?? 1) - (next.zoom ?? 1)) >= NATIVE_WEBVIEW_ZOOM_EPSILON
  );
}

export function ToolBrowserPanel({ target, onTargetChange, onClose, onResizeStart }: ToolBrowserPanelProps) {
  const [displayMode, setDisplayMode] = useState<ToolBrowserDisplayMode>(() => storedDisplayMode());
  const [tabs, setTabs] = useState<ToolBrowserTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const panelRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const displayModeRef = useRef(displayMode);
  const lastNativeBoundsRef = useRef<EmbeddedToolBrowserBounds | null>(null);
  const nativeBoundsFrameRef = useRef<number | null>(null);
  const nativeBoundsSyncStatsRef = useRef<NativeBoundsSyncStats>({
    skipped: 0,
    sent: 0,
    lastReason: null,
  });
  const targetRef = useRef(target);
  const nextTabIdRef = useRef(1);
  const isNativeEmbedded = isTauriRuntime();

  const openTab = useCallback((url: string) => {
    const tab = {
      id: `tool-browser-tab-${nextTabIdRef.current++}`,
      url,
      host: targetHost(url),
    };
    setTabs((currentTabs) => [...currentTabs, tab]);
    setActiveTabId(tab.id);
  }, []);

  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!target) return;
    openTab(target);
  }, [openTab, target]);

  useEffect(() => {
    if (target) return;
    setTabs([]);
    setActiveTabId(null);
    setAddressDraft("");
  }, [target]);

  useEffect(() => {
    if (!isNativeEmbedded) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void subscribeToolBrowserTabOpen((url) => {
      if (!targetRef.current) return;
      openTab(url);
    }).then((nextUnlisten) => {
      if (cancelled) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isNativeEmbedded, openTab]);

  const activeTab = target ? tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null : null;
  const activeTarget = target ? activeTab?.url ?? target : null;

  useEffect(() => {
    setAddressDraft(activeTarget ?? "");
  }, [activeTarget]);

  useEffect(() => {
    if (activeTarget) onTargetChange(activeTarget);
  }, [activeTarget, onTargetChange]);

  useEffect(() => {
    displayModeRef.current = displayMode;
    try {
      window.localStorage.setItem(TOOL_BROWSER_DISPLAY_MODE_STORAGE_KEY, displayMode);
    } catch {
      // Ignore storage failures; display mode should still work for the current session.
    }
  }, [displayMode]);

  const measureBounds = useCallback((): EmbeddedToolBrowserBounds | null => {
    const panel = panelRef.current;
    const header = headerRef.current;
    if (!panel || !header) return null;
    const panelRect = panel.getBoundingClientRect();
    const headerHeight = header.getBoundingClientRect().height;
    const x = Math.round(panelRect.left + NATIVE_WEBVIEW_EDGE_INSET);
    const y = Math.round(panelRect.top + headerHeight + NATIVE_WEBVIEW_TOP_GUARD);
    const width = Math.round(panelRect.width - NATIVE_WEBVIEW_EDGE_INSET * 2);
    const height = Math.round(panelRect.height - headerHeight - NATIVE_WEBVIEW_TOP_GUARD - NATIVE_WEBVIEW_EDGE_INSET);
    if (width <= 0 || height <= 0) return null;
    return {
      x,
      y,
      width,
      height,
      zoom: displayModeRef.current === "desktop-fit"
        ? Math.max(0.25, Math.min(1, width / TOOL_BROWSER_DESKTOP_VIEWPORT_WIDTH))
        : 1,
    };
  }, []);

  const syncNativeBounds = useCallback((reason: NativeBoundsSyncReason) => {
    const bounds = measureBounds();
    if (!bounds) return;
    const stats = nativeBoundsSyncStatsRef.current;
    stats.lastReason = reason;
    if (!boundsChanged(lastNativeBoundsRef.current, bounds)) {
      stats.skipped += 1;
      return;
    }
    lastNativeBoundsRef.current = bounds;
    stats.sent += 1;
    if (stats.sent % 120 === 0) {
      console.debug("Embedded Tool Browser bounds sync", { ...stats, bounds });
    }
    void setEmbeddedToolBrowserBounds(bounds).catch((error) => {
      console.error("Failed to sync embedded Tool Browser bounds", error);
    });
  }, [measureBounds]);

  const scheduleNativeBoundsSync = useCallback((reason: NativeBoundsSyncReason) => {
    if (!isNativeEmbedded) return;
    if (nativeBoundsFrameRef.current !== null) return;
    nativeBoundsFrameRef.current = window.requestAnimationFrame(() => {
      nativeBoundsFrameRef.current = null;
      syncNativeBounds(reason);
    });
  }, [isNativeEmbedded, syncNativeBounds]);

  useEffect(() => {
    if (!activeTarget || !isNativeEmbedded) return;
    let cancelled = false;
    let frame: number | null = null;

    const requestBoundsSync = () => {
      if (cancelled) return;
      scheduleNativeBoundsSync("resize");
    };

    const openNativeView = () => {
      const bounds = measureBounds();
      if (!bounds) {
        frame = window.requestAnimationFrame(openNativeView);
        return;
      }
      lastNativeBoundsRef.current = bounds;
      void openEmbeddedToolBrowser(activeTarget, bounds).catch((error) => {
        console.error("Failed to open embedded Tool Browser", error);
      });
    };

    frame = window.requestAnimationFrame(openNativeView);
    const observer = new ResizeObserver(requestBoundsSync);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (headerRef.current) observer.observe(headerRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", requestBoundsSync);

    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", requestBoundsSync);
    };
  }, [activeTarget, isNativeEmbedded, measureBounds, scheduleNativeBoundsSync]);

  useEffect(() => {
    if (!activeTarget || !isNativeEmbedded) return;
    scheduleNativeBoundsSync("display-mode");
  }, [activeTarget, displayMode, isNativeEmbedded, scheduleNativeBoundsSync]);

  useEffect(() => {
    if (!activeTarget || !isNativeEmbedded) return;
    scheduleNativeBoundsSync("tabs");
  }, [activeTarget, isNativeEmbedded, scheduleNativeBoundsSync, tabs.length]);

  useEffect(() => {
    if (activeTarget || !isNativeEmbedded) return;
    if (nativeBoundsFrameRef.current !== null) {
      window.cancelAnimationFrame(nativeBoundsFrameRef.current);
      nativeBoundsFrameRef.current = null;
    }
    lastNativeBoundsRef.current = null;
    nativeBoundsSyncStatsRef.current = { skipped: 0, sent: 0, lastReason: null };
    void closeEmbeddedToolBrowser().catch((error) => {
      console.error("Failed to close embedded Tool Browser", error);
    });
  }, [activeTarget, isNativeEmbedded]);

  useEffect(() => {
    if (!isNativeEmbedded) return;
    return () => {
      if (nativeBoundsFrameRef.current !== null) {
        window.cancelAnimationFrame(nativeBoundsFrameRef.current);
        nativeBoundsFrameRef.current = null;
      }
      void closeEmbeddedToolBrowser();
    };
  }, [isNativeEmbedded]);

  if (!activeTarget) return null;
  const host = activeTab?.host ?? targetHost(activeTarget);
  const isDesktopFit = displayMode === "desktop-fit";
  const nextMode: ToolBrowserDisplayMode = isDesktopFit ? "responsive" : "desktop-fit";

  const closePanel = () => {
    if (isNativeEmbedded) {
      void closeEmbeddedToolBrowser()
        .catch((error) => {
          console.error("Failed to hide embedded Tool Browser", error);
        })
        .finally(onClose);
      return;
    }
    onClose();
  };

  const navigateActiveTab = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const targetUrl = toolBrowserTargetFromHref(trimmed) ?? toolBrowserTargetFromHref(`https://${trimmed}`);
    if (!targetUrl) {
      setAddressDraft(activeTarget);
      return;
    }
    if (activeTab) {
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.id === activeTab.id
            ? { ...tab, url: targetUrl, host: targetHost(targetUrl) }
            : tab,
        )
      );
      setActiveTabId(activeTab.id);
    } else {
      openTab(targetUrl);
    }
    setAddressDraft(targetUrl);
  };

  const closeTab = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    if (tabs.length <= 1) {
      closePanel();
      return;
    }
    const isActive = activeTabId === tabId || (!activeTabId && index === 0);
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    if (isActive) {
      const nextActiveTab = nextTabs[Math.min(index, nextTabs.length - 1)];
      setActiveTabId(nextActiveTab.id);
    }
    setTabs(nextTabs);
  };

  return (
    <aside ref={panelRef} className="tool-browser-panel" data-display-mode={displayMode} aria-label="Embedded Tool Browser">
      <button
        type="button"
        className="tool-browser-resize-handle"
        aria-label="Resize embedded browser panel"
        title="Resize embedded browser panel"
        onPointerDown={onResizeStart}
      />
      <header ref={headerRef} className="tool-browser-panel-header">
        <div className="tool-browser-nav-actions">
          <button
            type="button"
            className="tool-browser-control-button"
            title="Back"
            aria-label="Go back"
            onClick={() => {
              void goBackEmbeddedToolBrowser();
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="tool-browser-control-button"
            title="Forward"
            aria-label="Go forward"
            onClick={() => {
              void goForwardEmbeddedToolBrowser();
            }}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="tool-browser-tabs" role="tablist" aria-label="Tool Browser tabs">
          {tabs.map((tab) => {
            const isActive = activeTab?.id === tab.id;
            return (
              <div
                key={tab.id}
                className="tool-browser-tab"
                data-active={isActive ? "true" : "false"}
                role="presentation"
              >
                <button
                  type="button"
                  className="tool-browser-tab-button"
                  role="tab"
                  aria-selected={isActive}
                  title={tab.url}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <span>{tab.host}</span>
                </button>
                <button
                  type="button"
                  className="tool-browser-tab-close"
                  aria-label={`Close ${tab.host}`}
                  title={`Close ${tab.host}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="tool-browser-control-button tool-browser-new-tab-button"
            title="Duplicate current tab"
            aria-label="Duplicate current tab"
            onClick={() => openTab(activeTarget)}
          >
            <Plus size={15} />
          </button>
        </div>
        <form
          className="tool-browser-address-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigateActiveTab(addressDraft);
          }}
        >
          <input
            type="text"
            value={addressDraft}
            aria-label="Tool Browser URL"
            spellCheck={false}
            onChange={(event) => setAddressDraft(event.currentTarget.value)}
            onBlur={() => setAddressDraft(activeTarget)}
          />
        </form>
        <div className="tool-browser-panel-actions">
          <button
            type="button"
            className="tool-browser-control-button"
            title={isDesktopFit ? "Use responsive mobile layout" : "Use desktop preview layout"}
            aria-label={isDesktopFit ? "Use responsive mobile layout" : "Use desktop preview layout"}
            aria-pressed={isDesktopFit}
            onClick={() => setDisplayMode(nextMode)}
          >
            {isDesktopFit ? <Smartphone size={15} /> : <MonitorSmartphone size={15} />}
          </button>
          <button
            type="button"
            className="tool-browser-control-button"
            title="Open externally"
            aria-label="Open externally"
            onClick={() => {
              void openExternalUrl(activeTarget);
            }}
          >
            <ExternalLink size={15} />
          </button>
          <button type="button" className="tool-browser-control-button" title="Close" aria-label="Close Tool Browser" onClick={closePanel}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div ref={viewportRef} className="tool-browser-viewport">
        {isNativeEmbedded ? (
          <div className="tool-browser-native-placeholder" aria-hidden="true" />
        ) : (
          <div className="tool-browser-page-scale">
            <iframe
              key={activeTarget}
              className="tool-browser-frame"
              title={`Tool Browser: ${host}`}
              src={activeTarget}
              sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-top-navigation-by-user-activation"
              allow="autoplay; clipboard-read; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="no-referrer"
            />
          </div>
        )}
      </div>
    </aside>
  );
}
