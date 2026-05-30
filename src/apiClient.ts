import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

const UI_REFRESH_EVENT = "lantor://refresh";
const TOOL_BROWSER_OPEN_TAB_EVENT = "lantor://tool-browser-open-tab";
const WEB_AUTH_STORAGE_KEY = "lantor.webAuth";
const WEB_AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOOL_BROWSER_TARGET_MAX_LENGTH = 4096;

type WebAuthState = {
  token: string;
  expiresAt: number;
};

export class ApiClientError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, options: { code?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = "ApiClientError";
    this.code = options.code ?? null;
    this.status = options.status ?? null;
  }
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    await tauriInvoke("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export type ToolBrowserWindowInfo = {
  label: string;
  url: string;
  host: string;
  isLoopback: boolean;
  created: boolean;
};

function unsupportedToolBrowserRuntime(): ApiClientError {
  return new ApiClientError("Tool Browser is only available in the desktop app.", {
    code: "unsupportedRuntime",
  });
}

export function toolBrowserTargetFromHref(href: string | undefined | null): string | null {
  const target = href?.trim();
  if (!target || target.length > TOOL_BROWSER_TARGET_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(target)) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}

export function canOpenToolBrowserTarget(href: string | undefined | null) {
  return toolBrowserTargetFromHref(href) !== null;
}

export async function openToolBrowser(target: string): Promise<ToolBrowserWindowInfo> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  return tauriInvoke<ToolBrowserWindowInfo>("open_tool_browser", { target });
}

export async function retargetToolBrowser(target: string): Promise<ToolBrowserWindowInfo> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  return tauriInvoke<ToolBrowserWindowInfo>("retarget_tool_browser", { target });
}

export async function focusToolBrowser(): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("focus_tool_browser");
}

export async function closeToolBrowser(): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("close_tool_browser");
}

export type EmbeddedToolBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom?: number;
};

export async function openEmbeddedToolBrowser(
  target: string,
  bounds: EmbeddedToolBrowserBounds,
): Promise<ToolBrowserWindowInfo> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  return tauriInvoke<ToolBrowserWindowInfo>("open_embedded_tool_browser", {
    target,
    ...bounds,
  });
}

export async function setEmbeddedToolBrowserBounds(bounds: EmbeddedToolBrowserBounds): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("set_embedded_tool_browser_bounds", bounds);
}

export async function closeEmbeddedToolBrowser(): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("close_embedded_tool_browser");
}

export async function goBackEmbeddedToolBrowser(): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("go_back_embedded_tool_browser");
}

export async function goForwardEmbeddedToolBrowser(): Promise<void> {
  if (!isTauriRuntime()) throw unsupportedToolBrowserRuntime();
  await tauriInvoke("go_forward_embedded_tool_browser");
}

export async function subscribeToolBrowserTabOpen(handler: (target: string) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return tauriListen<string>(TOOL_BROWSER_OPEN_TAB_EVENT, (event) => handler(event.payload));
}

function apiPath(command: string) {
  return `/api/${command}`;
}

function webAuthFromUrl() {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("token")?.trim();
  if (!token) return null;
  saveWebAuthToken(token);
  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}

function storedWebAuthToken() {
  if (typeof window === "undefined") return null;
  const urlToken = webAuthFromUrl();
  if (urlToken) return urlToken;
  try {
    const raw = window.localStorage.getItem(WEB_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as Partial<WebAuthState>;
    if (!state.token || !state.expiresAt || Date.now() >= state.expiresAt) {
      window.localStorage.removeItem(WEB_AUTH_STORAGE_KEY);
      return null;
    }
    return state.token;
  } catch {
    window.localStorage.removeItem(WEB_AUTH_STORAGE_KEY);
    return null;
  }
}

function saveWebAuthToken(token: string) {
  if (typeof window === "undefined") return;
  const state: WebAuthState = {
    token,
    expiresAt: Date.now() + WEB_AUTH_TTL_MS,
  };
  window.localStorage.setItem(WEB_AUTH_STORAGE_KEY, JSON.stringify(state));
}

function clearWebAuthToken() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(WEB_AUTH_STORAGE_KEY);
  }
}

function requestWebAuthToken() {
  if (typeof window === "undefined") return null;
  const token = window.prompt("Enter Lantor web token")?.trim();
  if (!token) return null;
  saveWebAuthToken(token);
  return token;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function webFetch(command: string, args: Record<string, unknown>, retryAuth: boolean): Promise<Response> {
  const token = storedWebAuthToken();
  const response = command === "bootstrap"
    ? await fetch(apiPath("bootstrap"), { headers: authHeaders(token) })
    : await fetch(apiPath(command), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(args),
    });
  if (response.status !== 401 || !retryAuth) return response;

  clearWebAuthToken();
  const nextToken = requestWebAuthToken();
  if (!nextToken) return response;
  return command === "bootstrap"
    ? fetch(apiPath("bootstrap"), { headers: authHeaders(nextToken) })
    : fetch(apiPath(command), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(nextToken),
      },
      body: JSON.stringify(args),
    });
}

export async function apiInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(command, args);
  }

  const response = await webFetch(command, args, true);

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!contentType.includes("application/json")) {
    throw new ApiClientError(
      `Expected JSON from ${apiPath(command)}, got ${contentType || "unknown content type"}. `
      + "If you opened the Vite dev URL directly, make sure the configured Lantor backend is running.",
      { code: "expectedJson", status: response.status },
    );
  }
  if (!response.ok) {
    const payloadRecord = typeof payload === "object" && payload ? payload as Record<string, unknown> : null;
    const message = payloadRecord && "message" in payloadRecord
      ? String(payloadRecord.message)
      : String(payload || `${command} failed`);
    const code = payloadRecord && typeof payloadRecord.code === "string" ? payloadRecord.code : null;
    throw new ApiClientError(message, { code, status: response.status });
  }
  return payload as T;
}

type BackendEventConnectionState = "open" | "error";

export async function subscribeBackendEvents(
  handler: (payload: string) => void,
  onConnectionState?: (state: BackendEventConnectionState) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    onConnectionState?.("open");
    return tauriListen<string>(UI_REFRESH_EVENT, (event) => handler(event.payload));
  }

  const token = storedWebAuthToken();
  const eventsUrl = token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
  const source = new EventSource(eventsUrl);
  source.onopen = () => {
    onConnectionState?.("open");
  };
  source.addEventListener("lantor", (event) => {
    handler((event as MessageEvent<string>).data);
  });
  source.onerror = () => {
    onConnectionState?.("error");
    console.error("Lantor web event stream disconnected");
  };
  return () => source.close();
}

export function attachmentAssetUrl(storagePath: string, attachmentId: string) {
  if (isTauriRuntime()) {
    return convertFileSrc(storagePath);
  }
  const token = storedWebAuthToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/attachments/${attachmentId}${suffix}`;
}
