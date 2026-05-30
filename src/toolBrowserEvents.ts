export const TOOL_BROWSER_TOGGLE_EVENT = "lantor:tool-browser-toggle";

export type ToolBrowserToggleDetail = {
  target: string;
};

export function dispatchToolBrowserToggle(target: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToolBrowserToggleDetail>(TOOL_BROWSER_TOGGLE_EVENT, {
    detail: { target },
  }));
}

export function isToolBrowserToggleEvent(event: Event): event is CustomEvent<ToolBrowserToggleDetail> {
  if (event.type !== TOOL_BROWSER_TOGGLE_EVENT) return false;
  const detail = (event as CustomEvent<ToolBrowserToggleDetail>).detail;
  return typeof detail?.target === "string" && detail.target.trim().length > 0;
}
