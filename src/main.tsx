import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { Bookmark, Home, Inbox, Phone, Search } from "lucide-react";
import { apiInvoke, isTauriRuntime, subscribeBackendEvents, toolBrowserTargetFromHref } from "./apiClient";
import { APP_DISPLAY_NAME } from "./branding";
import { AgentDetailDrawer } from "./components/AgentDetailDrawer";
import type { AgentPerformance } from "./components/AgentDetailDrawer";
import { AgentFormModal } from "./components/AgentFormModal";
import { randomDylanAvatarSpec } from "./avatar-utils";
import { ChannelAgentsModal } from "./components/ChannelAgentsModal";
import { ChannelSettingsModal } from "./components/ChannelSettingsModal";
import { CallConsole } from "./components/CallConsole";
import { ConfirmModal } from "./components/ConfirmModal";
import { Conversation } from "./components/Conversation";
import { CreateChannelModal } from "./components/CreateChannelModal";
import { ActivityFeedModal } from "./components/ActivityFeedModal";
import { DiagnosticsModal, type RefreshMetricsSnapshot } from "./components/DiagnosticsModal";
import { OwnerProfileModal, ownerProfileToForm, type OwnerProfileForm } from "./components/OwnerProfileModal";
import { SavedMessagesModal } from "./components/SavedMessagesModal";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal, type ChatTextSize } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { ThreadPanel } from "./components/ThreadPanel";
import { ToolBrowserPanel } from "./components/ToolBrowserPanel";
import type { LocalEntityLinkTarget } from "./components/MessageMarkdown";
import { isProgressOnlyMessage } from "./message-grouping";
import { agentMentionBinding, serializeAgentDisplayMentions, type AgentMentionBinding } from "./mentions";
import { isToolBrowserToggleEvent, TOOL_BROWSER_TOGGLE_EVENT } from "./toolBrowserEvents";
import {
  ACTIVE_RUN_STATUSES,
  Agent,
  AgentActivity,
  AgentForm,
  AgentRun,
  AgentWorkItem,
  Artifact,
  Bootstrap,
  CallDispatch,
  CallSession,
  CallUtterance,
  DraftAttachment,
  EMPTY_AGENT_FORM,
  ActivityFeedItem,
  Message,
  MessageAttachment,
  RUNTIME_PRESETS,
  RuntimeCheck,
  SavedMessage,
  SearchResult,
  SearchScope,
  SearchTimeRange,
  Task,
  ThreadActivity,
  ThreadReplySummary,
  TodoItem,
} from "./types";
import { agentRequestSourceLabel, buildPresetCommand, displayNameForSender, firstLines, formatTime, timestampMs, visibleChannelDescription } from "./ui-utils";
import "./styles.css";

type RefreshMetrics = RefreshMetricsSnapshot & {
  lastSummaryAt: number;
};

type RefreshRequest = {
  reason: string;
  source: string;
  fallback: string;
  includeOptimistic: boolean;
  preferredActiveChannelId?: string;
};

declare global {
  interface Window {
    __LANTOR_REFRESH_METRICS__?: RefreshMetricsSnapshot;
  }
}

function createRefreshMetrics(): RefreshMetrics {
  const now = Date.now();
  return {
    startedAt: now,
    bootstrapCount: 0,
    bootstrapByReason: {},
    bootstrapBySource: {},
    requestCount: 0,
    requestByReason: {},
    coalescedRequestCount: 0,
    coalescedRequestByReason: {},
    queuedRequestCount: 0,
    queuedRequestByReason: {},
    stateUpdateCount: 0,
    stateUpdateByReason: {},
    lastBootstrapAt: null,
    lastBootstrapReason: null,
    lastSummaryAt: now,
  };
}

function incrementMetric(bucket: Record<string, number>, key: string) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function metricRatePerMinute(count: number, startedAt: number, now: number) {
  const minutes = Math.max((now - startedAt) / 60_000, 1 / 60);
  return Number((count / minutes).toFixed(2));
}

function topMetricEntries(bucket: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(bucket)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12),
  );
}

function refreshMetricsSnapshot(metrics: RefreshMetrics): RefreshMetricsSnapshot {
  return {
    startedAt: metrics.startedAt,
    bootstrapCount: metrics.bootstrapCount,
    bootstrapByReason: { ...metrics.bootstrapByReason },
    bootstrapBySource: { ...metrics.bootstrapBySource },
    requestCount: metrics.requestCount,
    requestByReason: { ...metrics.requestByReason },
    coalescedRequestCount: metrics.coalescedRequestCount,
    coalescedRequestByReason: { ...metrics.coalescedRequestByReason },
    queuedRequestCount: metrics.queuedRequestCount,
    queuedRequestByReason: { ...metrics.queuedRequestByReason },
    stateUpdateCount: metrics.stateUpdateCount,
    stateUpdateByReason: { ...metrics.stateUpdateByReason },
    lastBootstrapAt: metrics.lastBootstrapAt,
    lastBootstrapReason: metrics.lastBootstrapReason,
  };
}

const ACTIVITY_PHASE_LABELS: Record<string, string> = {
  thinking: "Thinking",
  command: "Running command",
  file_edit: "Editing file",
  runtime: "Runtime",
  work: "Work",
  profile: "Profile",
  acting: "Acting",
  tools: "Using tools",
  error: "Error",
  event: "Acting",
  message: "Acting",
  task: "Acting",
  event_error: "Error",
  run_error: "Error",
  run_retry: "Retrying",
};

const DEFAULT_THREAD_PANEL_WIDTH = 420;
const MIN_THREAD_PANEL_WIDTH = 320;
const DEFAULT_AGENT_DRAWER_WIDTH = 420;
const MIN_AGENT_DRAWER_WIDTH = 320;
const TOOL_BROWSER_PAGE_VIEWPORT_WIDTH = 1180;
const TOOL_BROWSER_PAGE_VIEWPORT_HEIGHT = 820;
const TOOL_BROWSER_PAGE_ASPECT_RATIO = TOOL_BROWSER_PAGE_VIEWPORT_WIDTH / TOOL_BROWSER_PAGE_VIEWPORT_HEIGHT;
const TOOL_BROWSER_MOBILE_FLOOR_WIDTH = 360;
const TOOL_BROWSER_PANEL_HEADER_HEIGHT = 40;
const DEFAULT_TOOL_BROWSER_PANEL_WIDTH = 420;
const MIN_TOOL_BROWSER_PANEL_WIDTH = 320;
const MAX_TOOL_BROWSER_PANEL_WIDTH = 560;
const DEFAULT_SIDEBAR_WIDTH = 292;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 460;
const MIN_CONVERSATION_WIDTH = 480;
const MOBILE_BREAKPOINT = 760;
const UI_REFRESH_DEBOUNCE_MS = 80;
const EPHEMERAL_FLUSH_FALLBACK_MS = 80;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ACTIVITY_HISTORY_LIMIT_PER_AGENT = 40;
const RECENT_NON_CALL_WORK_ITEM_LIMIT = 40;
const RUN_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped", "exited"]);
const DEFAULT_OWNER_DISPLAY_NAME = "Me";
const DEFAULT_OWNER_AVATAR = "dicebear:dylan:owner";
const DEFAULT_OWNER_DESCRIPTION = "local owner";
const OWNER_MENTION_HANDLES = ["@Theo", "@Dylan"];
const CHANNEL_THREAD_MEMORY_STORAGE_KEY = "lantor.channelThreadMemory";
const THREAD_PANEL_WIDTH_STORAGE_KEY = "lantor.threadPanelWidth";
const AGENT_DRAWER_WIDTH_STORAGE_KEY = "lantor.agentDrawerWidth";
const TOOL_BROWSER_PANEL_WIDTH_STORAGE_KEY = "lantor.toolBrowserEmbeddedPanelWidth";
const TOOL_BROWSER_LAST_TARGET_STORAGE_KEY = "lantor.toolBrowserLastTarget";
const DEFAULT_TOOL_BROWSER_TARGET = "https://www.bilibili.com/";
const SIDEBAR_WIDTH_STORAGE_KEY = "lantor.sidebarWidth";
const CHAT_TEXT_SIZE_STORAGE_KEY = "lantor.chatTextSize";
const CHAT_TEXT_SIZE_OPTIONS: ChatTextSize[] = ["compact", "default", "large", "xlarge"];
const CHAT_TEXT_SIZE_STYLES: Record<ChatTextSize, Record<string, string>> = {
  compact: {
    "--type-size-caption": "10px",
    "--type-size-meta": "11px",
    "--type-size-body": "13px",
    "--type-size-message": "14px",
    "--type-size-control": "15px",
    "--type-size-title": "17px",
    "--type-size-display": "20px",
  },
  default: {
    "--type-size-caption": "11px",
    "--type-size-meta": "12px",
    "--type-size-body": "13px",
    "--type-size-message": "15px",
    "--type-size-control": "16px",
    "--type-size-title": "20px",
    "--type-size-display": "22px",
  },
  large: {
    "--type-size-caption": "12px",
    "--type-size-meta": "13px",
    "--type-size-body": "14px",
    "--type-size-message": "16px",
    "--type-size-control": "17px",
    "--type-size-title": "22px",
    "--type-size-display": "24px",
  },
  xlarge: {
    "--type-size-caption": "13px",
    "--type-size-meta": "14px",
    "--type-size-body": "15px",
    "--type-size-message": "18px",
    "--type-size-control": "19px",
    "--type-size-title": "24px",
    "--type-size-display": "26px",
  },
};
const MOBILE_EDGE_SWIPE_START_PX = 24;
const MOBILE_EDGE_SWIPE_OPEN_PX = 72;
const MOBILE_EDGE_SWIPE_MAX_VERTICAL_PX = 48;
const MOBILE_SIDEBAR_PEEK_PX = 18;
const MOBILE_SIDEBAR_FLING_VELOCITY = 0.45;
const BACKEND_CONNECTED_FULL_REFRESH_MS = 60_000;
const BACKEND_DISCONNECTED_REFRESH_MS = 5_000;
const REFRESH_METRICS_SUMMARY_MS = 30_000;
const SAVED_MESSAGES_READ_DISMISS_ID = "saved-messages";
const CHANNEL_MESSAGE_PAGE_SIZE = 120;
const THREAD_MESSAGE_PAGE_SIZE = 240;
function safeDecodeLocalSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function localTargetFromHash(hash: string): LocalEntityLinkTarget | null {
  if (hash.startsWith("#/message/")) {
    const messageRef = safeDecodeLocalSegment(hash.replace("#/message/", ""));
    return messageRef ? { type: "message", messageRef } : null;
  }
  if (hash.startsWith("#/agent/")) {
    const handle = safeDecodeLocalSegment(hash.replace("#/agent/", ""));
    return handle ? { type: "agent", handle } : null;
  }
  if (hash.startsWith("#/task/")) {
    const taskNumber = Number(safeDecodeLocalSegment(hash.replace("#/task/", "")));
    return Number.isInteger(taskNumber) && taskNumber > 0 ? { type: "task", taskNumber } : null;
  }
  if (hash.startsWith("#/channel/")) {
    const [encodedChannelRef, maybeThreadSegment, encodedThreadRef] = hash
      .replace("#/channel/", "")
      .split("/");
    const channelRef = safeDecodeLocalSegment(encodedChannelRef);
    const threadRef = maybeThreadSegment === "thread" && encodedThreadRef
      ? safeDecodeLocalSegment(encodedThreadRef)
      : null;
    return channelRef ? { type: "channel", channelRef, threadRef } : null;
  }
  return null;
}

type UiBackendEvent =
  | { type: "refresh"; reason?: string }
  | { type: "batch"; events: string[] }
  | { type: "agent_upsert"; reason?: string; agent: Agent }
  | { type: "message_upsert"; reason?: string; message: Message }
  | { type: "message_delta"; reason?: string; message_id: string; append: string; delivery_state: Message["delivery_state"] }
  | { type: "message_delete"; reason?: string; message_id: string }
  | { type: "activity_upsert"; reason?: string; activity: AgentActivity }
  | { type: "agent_run_upsert"; reason?: string; run: Omit<AgentRun, "log"> & { log?: string } }
  | { type: "work_item_upsert"; reason?: string; work_item: Omit<AgentWorkItem, "context"> & { context?: string } }
  | { type: "call_session_upsert"; reason?: string; session: CallSession }
  | { type: "call_utterance_upsert"; reason?: string; utterance: CallUtterance }
  | { type: "call_dispatch_upsert"; reason?: string; dispatch: CallDispatch }
  | { type: "artifact_upsert"; reason?: string; artifact: Artifact }
  | { type: "tool_browser_open"; reason?: string; target: string };

type FlatUiBackendEvent = Exclude<UiBackendEvent, { type: "batch" }>;
type EphemeralActivityBufferItem = {
  activity: AgentActivity;
  reason: string;
};
type EphemeralRunBufferItem = {
  run: Omit<AgentRun, "log"> & { log?: string };
  reason: string;
};

type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
};

type ActiveTab = "chat" | "tasks" | "longTasks";
type MainView = "channels" | "voice";
type MobileModal = "search" | "activity" | "saved";

type AppHistoryState = {
  __lantorUiHistory?: true;
  __lantorMobileUi?: true;
  index: number;
  activeChannelId: string | null;
  activeThreadId: string | null;
  activeTab: ActiveTab;
  showThread: boolean;
  showMobileSidebar: boolean;
  selectedAgentId: string | null;
  activeModal: MobileModal | null;
};

type AppErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
};

function phaseForActivity(kind: string) {
  return ACTIVITY_PHASE_LABELS[kind] ?? "Active";
}

function activityOwnerKey(activity: AgentActivity) {
  return activity.agent_id ?? `handle:${activity.agent_handle || "unknown"}`;
}

function limitActivitiesPerAgent(activities: AgentActivity[]) {
  const counts = new Map<string, number>();
  return [...activities]
    .sort((left, right) => timestampMs(right.created_at) - timestampMs(left.created_at))
    .filter((activity) => {
      const key = activityOwnerKey(activity);
      const count = counts.get(key) ?? 0;
      if (count >= ACTIVITY_HISTORY_LIMIT_PER_AGENT) return false;
      counts.set(key, count + 1);
      return true;
    });
}

function retainWorkItemsForUi(workItems: AgentWorkItem[]) {
  const sorted = [...workItems]
    .sort((left, right) => timestampMs(right.created_at) - timestampMs(left.created_at));
  const callWorkItems = sorted.filter((item) => item.call_session_id);
  const recentNonCallWorkItems = sorted
    .filter((item) => !item.call_session_id)
    .slice(0, RECENT_NON_CALL_WORK_ITEM_LIMIT);
  return [...callWorkItems, ...recentNonCallWorkItems]
    .sort((left, right) => timestampMs(right.created_at) - timestampMs(left.created_at));
}

function isTextInput(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
}

function isActionControl(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a, [role='button'], [role='tab']"));
}

function messageStreamPrefixUuid(message: Message) {
  const [key] = message.stream_key.split(":");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
    ? key.toLowerCase()
    : null;
}

function isMobileViewport() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function isAppHistoryState(value: unknown): value is AppHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (state.__lantorUiHistory === true || state.__lantorMobileUi === true)
    && typeof state.index === "number"
    && (state.activeChannelId === undefined || state.activeChannelId === null || typeof state.activeChannelId === "string")
    && (state.activeThreadId === undefined || state.activeThreadId === null || typeof state.activeThreadId === "string")
    && (state.activeTab === undefined || state.activeTab === "chat" || state.activeTab === "tasks" || state.activeTab === "longTasks")
    && typeof state.showThread === "boolean"
    && typeof state.showMobileSidebar === "boolean"
    && (state.selectedAgentId === null || typeof state.selectedAgentId === "string")
    && (
      state.activeModal === null ||
      state.activeModal === "search" ||
      state.activeModal === "activity" ||
      state.activeModal === "saved"
    );
}

function appHistoryKey(state: AppHistoryState) {
  return [
    state.activeChannelId ?? "",
    state.activeThreadId ?? "",
    state.activeTab,
    state.showThread ? "thread" : "conversation",
    state.showMobileSidebar ? "sidebar" : "content",
    state.selectedAgentId ?? "",
    state.activeModal ?? "",
  ].join("|");
}

function errorMessage(err: unknown, fallback: string) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${APP_DISPLAY_NAME} UI crashed`, error, info);
    this.setState({ info });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const details = [
      this.state.error.stack || this.state.error.message,
      this.state.info?.componentStack,
    ].filter(Boolean).join("\n\n");

    return (
      <main className="fatal-shell notranslate" translate="no">
        <section className="fatal-card" role="alert">
          <p className="eyebrow">{APP_DISPLAY_NAME} UI crashed</p>
          <h1>Frontend render failed</h1>
          <p>
            The backend is still running. Reload the app to recover; the details below are kept
            visible so this does not become a blank window.
          </p>
          <div className="fatal-actions">
            <button type="button" onClick={() => window.location.reload()}>Reload {APP_DISPLAY_NAME}</button>
          </div>
          <pre>{details}</pre>
        </section>
      </main>
    );
  }
}

function maxRightPanelWidth(sidebarWidth: number, minPanelWidth: number, capToViewport = true) {
  const contentWidth = Math.max(0, window.innerWidth - sidebarWidth);
  const preserveConversationMax = contentWidth - MIN_CONVERSATION_WIDTH;
  const viewportMax = Math.floor(window.innerWidth * (2 / 3));
  const maxWidth = capToViewport
    ? Math.min(viewportMax, preserveConversationMax)
    : preserveConversationMax;
  const fallbackWidth = Math.min(minPanelWidth, Math.max(0, preserveConversationMax));
  return Math.max(fallbackWidth, maxWidth);
}

function maxThreadPanelWidth(sidebarWidth = DEFAULT_SIDEBAR_WIDTH) {
  return maxRightPanelWidth(sidebarWidth, MIN_THREAD_PANEL_WIDTH, false);
}

function maxAgentDrawerWidth(sidebarWidth = DEFAULT_SIDEBAR_WIDTH) {
  return maxRightPanelWidth(sidebarWidth, MIN_AGENT_DRAWER_WIDTH);
}

function maxToolBrowserPanelWidth(sidebarWidth = DEFAULT_SIDEBAR_WIDTH) {
  return Math.max(
    MIN_TOOL_BROWSER_PANEL_WIDTH,
    Math.min(MAX_TOOL_BROWSER_PANEL_WIDTH, window.innerWidth - sidebarWidth - MIN_CONVERSATION_WIDTH),
  );
}

function toolBrowserPanelHeightForWidth(width: number) {
  return TOOL_BROWSER_PANEL_HEADER_HEIGHT + Math.round(width / TOOL_BROWSER_PAGE_ASPECT_RATIO);
}

function toolBrowserMobileFloorScale(width: number) {
  return Math.min(1, width / TOOL_BROWSER_MOBILE_FLOOR_WIDTH);
}

function toolBrowserMobileFloorHeight(width: number, height: number) {
  const viewportHeight = Math.max(1, height - TOOL_BROWSER_PANEL_HEADER_HEIGHT);
  return Math.ceil(viewportHeight / toolBrowserMobileFloorScale(width));
}

function clampToolBrowserPanelWidth(width: number, sidebarWidth = DEFAULT_SIDEBAR_WIDTH) {
  return Math.min(maxToolBrowserPanelWidth(sidebarWidth), Math.max(MIN_TOOL_BROWSER_PANEL_WIDTH, width));
}

function storedToolBrowserTarget() {
  try {
    return toolBrowserTargetFromHref(window.localStorage.getItem(TOOL_BROWSER_LAST_TARGET_STORAGE_KEY)) ?? DEFAULT_TOOL_BROWSER_TARGET;
  } catch {
    return DEFAULT_TOOL_BROWSER_TARGET;
  }
}

function saveToolBrowserTarget(target: string) {
  try {
    window.localStorage.setItem(TOOL_BROWSER_LAST_TARGET_STORAGE_KEY, target);
  } catch {
    // Tool Browser should still open even if local storage is unavailable.
  }
}

function matchesSearchTime(value: string | null, range: SearchTimeRange) {
  if (range === "any" || !value) return true;
  const timestamp = timestampMs(value);
  if (Number.isNaN(timestamp)) return true;
  const now = Date.now();
  if (range === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return timestamp >= start.getTime();
  }
  const days = range === "7d" ? 7 : 30;
  return now - timestamp <= days * 24 * 60 * 60 * 1000;
}

function searchScopeAllows(scope: SearchScope, kind: SearchScope) {
  return scope === "all" || scope === kind;
}

function clientId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function draftAttachmentFromFile(file: File): DraftAttachment {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${clientId()}`,
    file,
    original_name: file.name,
    mime_type: file.type || "application/octet-stream",
    size_bytes: file.size,
  };
}

type ComposerDraftState = {
  text: string;
  attachments: DraftAttachment[];
  mentionBindings: AgentMentionBinding[];
};

type ChannelThreadMemory = Record<string, string | null>;

const EMPTY_COMPOSER_DRAFT: ComposerDraftState = {
  text: "",
  attachments: [],
  mentionBindings: [],
};

function isEmptyComposerDraft(draft: ComposerDraftState) {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

function updateComposerDraftRecord(
  current: Record<string, ComposerDraftState>,
  key: string | null | undefined,
  updater: (draft: ComposerDraftState) => ComposerDraftState,
) {
  if (!key) return current;
  const previous = current[key] ?? EMPTY_COMPOSER_DRAFT;
  const nextDraft = updater(previous);
  const next = { ...current };
  if (isEmptyComposerDraft(nextDraft)) {
    delete next[key];
  } else {
    next[key] = nextDraft;
  }
  return next;
}

function loadChannelThreadMemory(): ChannelThreadMemory {
  try {
    const raw = window.localStorage.getItem(CHANNEL_THREAD_MEMORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([channelId, threadId]) => channelId && (threadId === null || typeof threadId === "string")),
    ) as ChannelThreadMemory;
  } catch {
    return {};
  }
}

function getStoredNumber(key: string, fallback: number) {
  const stored = window.localStorage.getItem(key);
  return stored ? Number(stored) : fallback;
}

function getStoredChatTextSize(): ChatTextSize {
  const stored = window.localStorage.getItem(CHAT_TEXT_SIZE_STORAGE_KEY);
  return CHAT_TEXT_SIZE_OPTIONS.includes(stored as ChatTextSize) ? stored as ChatTextSize : "default";
}

function stepChatTextSize(current: ChatTextSize, delta: number) {
  const index = CHAT_TEXT_SIZE_OPTIONS.indexOf(current);
  const nextIndex = Math.min(
    CHAT_TEXT_SIZE_OPTIONS.length - 1,
    Math.max(0, index + delta),
  );
  return CHAT_TEXT_SIZE_OPTIONS[nextIndex] ?? "default";
}

async function attachmentUploads(attachments: DraftAttachment[]) {
  return Promise.all(attachments.map(async (attachment) => {
    const buffer = await attachment.file.arrayBuffer();
    return {
      originalName: attachment.original_name,
      mimeType: attachment.mime_type,
      bytes: Array.from(new Uint8Array(buffer)),
    };
  }));
}

function defaultAgentWorkspace(handle: string) {
  const normalized = handle.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_-]/g, "-");
  return normalized ? `~/Library/Application Support/Lantor/agents/${normalized}` : "";
}

function newAgentDraft(): AgentForm {
  return {
    ...EMPTY_AGENT_FORM,
    avatar: randomDylanAvatarSpec("new-agent"),
  };
}

function normalizeAgentHandle(value: string) {
  const cleaned = value
    .trim()
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const withLeadingLetter = /^[A-Za-z]/.test(cleaned)
    ? cleaned
    : cleaned
      ? `Agent-${cleaned}`
      : "Agent";
  return withLeadingLetter.length === 1 ? `${withLeadingLetter}Agent` : withLeadingLetter;
}

function availableAgentHandle(preferred: string, agents: Agent[], currentAgentId?: string) {
  const base = normalizeAgentHandle(preferred);
  const existing = new Set(
    agents
      .filter((agent) => agent.id !== currentAgentId)
      .map((agent) => agent.handle.toLowerCase()),
  );
  if (!existing.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = String(suffix);
    const next = `${base.slice(0, Math.max(1, 32 - suffixText.length))}${suffixText}`;
    if (!existing.has(next.toLowerCase())) return next;
  }
  return `${base.slice(0, 24)}${Date.now().toString().slice(-8)}`;
}

function numericMetadata(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function messageMentionsOwner(message: Message) {
  const body = message.body.toLowerCase();
  return OWNER_MENTION_HANDLES.some((handle) => body.includes(handle.toLowerCase()));
}

function budgetMicrosFromForm(value: string) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 1_000_000);
}

function budgetUsdFromMicros(value: number) {
  return value > 0 ? (value / 1_000_000).toFixed(2) : "";
}

function buildAgentPerformance(activities: AgentActivity[], runs: AgentRun[]): AgentPerformance {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = activities.filter((activity) => {
    const timestamp = timestampMs(activity.created_at);
    return Number.isNaN(timestamp) || timestamp >= cutoff;
  });
  const recentRuns = runs.filter((run) => {
    const timestamp = timestampMs(run.started_at);
    return Number.isNaN(timestamp) || timestamp >= cutoff;
  });
  const firstTokenMs = recent
    .map((activity) => numericMetadata(activity.metadata.first_token_ms))
    .filter((value): value is number => value !== null);
  const finishedTurns = recent.filter((activity) =>
    activity.phase === "runtime" &&
    ["Completed", "Failed", "Stopped"].includes(activity.title || activity.summary));
  const turnDurations = finishedTurns
    .filter((activity) => activity.status === "success")
    .map((activity) => numericMetadata(activity.metadata.duration_ms))
    .filter((value): value is number => value !== null);
  const failedTurns = finishedTurns.filter((activity) => activity.status === "error").length;
  const completedTurns = finishedTurns.filter((activity) => activity.status === "success").length;
  const activeTurns = recent.filter((activity) =>
    activity.phase === "runtime" &&
    activity.status === "active" &&
    (activity.title === "Started working" || activity.summary === "Started working")).length;
  const turns = completedTurns + failedTurns + activeTurns;
  const inputTokens = recentRuns.reduce((total, run) => total + (run.input_tokens || 0), 0);
  const outputTokens = recentRuns.reduce((total, run) => total + (run.output_tokens || 0), 0);
  const costMicros = recentRuns.reduce((total, run) => total + (run.cost_micros || 0), 0);

  return {
    windowLabel: "Last 24h",
    turns,
    completedTurns,
    failedTurns,
    activeTurns,
    p50FirstTokenMs: percentile(firstTokenMs, 0.5),
    p95FirstTokenMs: percentile(firstTokenMs, 0.95),
    p50TurnMs: percentile(turnDurations, 0.5),
    p95TurnMs: percentile(turnDurations, 0.95),
    errorRate: completedTurns + failedTurns === 0 ? 0 : failedTurns / (completedTurns + failedTurns),
    inputTokens,
    outputTokens,
    costMicros,
  };
}

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const messageLoadKeysRef = useRef<Set<string>>(new Set());
  const messageLoadInFlightRef = useRef<Set<string>>(new Set());
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const [activeMainView, setActiveMainView] = useState<MainView>("channels");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeVoiceThreadId, setActiveVoiceThreadId] = useState<string | null>(null);
  const [channelThreadMemory, setChannelThreadMemory] = useState<ChannelThreadMemory>(() => loadChannelThreadMemory());
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  const [rootComposerDrafts, setRootComposerDrafts] = useState<Record<string, ComposerDraftState>>({});
  const [replyComposerDrafts, setReplyComposerDrafts] = useState<Record<string, ComposerDraftState>>({});
  const [taskTitleDrafts, setTaskTitleDrafts] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [searchTimeRange, setSearchTimeRange] = useState<SearchTimeRange>("any");
  const [newChannel, setNewChannel] = useState("");
  const [newChannelNameSubmitError, setNewChannelNameSubmitError] = useState<string | null>(null);
  const [newChannelAgentIds, setNewChannelAgentIds] = useState<Set<string>>(() => new Set());
  const [channelNameDraft, setChannelNameDraft] = useState("");
  const [channelDescriptionDraft, setChannelDescriptionDraft] = useState("");
  const [ownerProfileDraft, setOwnerProfileDraft] = useState<OwnerProfileForm>({
    displayName: DEFAULT_OWNER_DISPLAY_NAME,
    avatar: DEFAULT_OWNER_AVATAR,
    description: DEFAULT_OWNER_DESCRIPTION,
  });
  const [agentDraft, setAgentDraft] = useState<AgentForm>(() => newAgentDraft());
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [agentEdit, setAgentEdit] = useState<AgentForm>(EMPTY_AGENT_FORM);
  const [showThread, setShowThread] = useState(() => window.innerWidth > MOBILE_BREAKPOINT);
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const [showChannelSettingsModal, setShowChannelSettingsModal] = useState(false);
  const [showChannelAgentsModal, setShowChannelAgentsModal] = useState(false);
  const [showCreateAgentModal, setShowCreateAgentModal] = useState(false);
  const [returnToCreateChannelAfterAgent, setReturnToCreateChannelAfterAgent] = useState(false);
  const [createChannelSubmitting, setCreateChannelSubmitting] = useState(false);
  const createChannelSubmittingRef = useRef(false);
  const createChannelOpenedFromMobileHomeRef = useRef(false);
  const createAgentOpenedFromMobileHomeRef = useRef(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showActivityFeedModal, setShowActivityFeedModal] = useState(false);
  const [showSavedModal, setShowSavedModal] = useState(false);
  const [showOwnerProfileModal, setShowOwnerProfileModal] = useState(false);
  const [showDiagnosticsModal, setShowDiagnosticsModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [chatTextSize, setChatTextSize] = useState<ChatTextSize>(() => getStoredChatTextSize());
  const [, setRefreshMetricsTick] = useState(0);
  const [showMobileSidebar, setShowMobileSidebar] = useState(() => isMobileViewport());
  const [mobileSidebarFocus, setMobileSidebarFocus] = useState<"home" | "dms">("home");
  const [mobileSidebarDragPx, setMobileSidebarDragPx] = useState(0);
  const [mobileDragSurface, setMobileDragSurface] = useState<"sidebar" | "panel" | null>(null);
  const [mobileComposerFocused, setMobileComposerFocused] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [runtimeChecks, setRuntimeChecks] = useState<Record<string, RuntimeCheck>>({});
  const [longTaskRefreshNonce, setLongTaskRefreshNonce] = useState(0);
  const [threadPanelWidth, setThreadPanelWidth] = useState(() => {
    const value = getStoredNumber(
      THREAD_PANEL_WIDTH_STORAGE_KEY,
      DEFAULT_THREAD_PANEL_WIDTH,
    );
    return Number.isFinite(value)
      ? Math.min(maxThreadPanelWidth(DEFAULT_SIDEBAR_WIDTH), Math.max(MIN_THREAD_PANEL_WIDTH, value))
      : DEFAULT_THREAD_PANEL_WIDTH;
  });
  const [toolBrowserTarget, setToolBrowserTarget] = useState<string | null>(null);
  const [toolBrowserPanelWidth, setToolBrowserPanelWidth] = useState(() => {
    const value = getStoredNumber(
      TOOL_BROWSER_PANEL_WIDTH_STORAGE_KEY,
      DEFAULT_TOOL_BROWSER_PANEL_WIDTH,
    );
    return Number.isFinite(value)
      ? clampToolBrowserPanelWidth(value, DEFAULT_SIDEBAR_WIDTH)
      : DEFAULT_TOOL_BROWSER_PANEL_WIDTH;
  });
  const [toolBrowserPanelHeight, setToolBrowserPanelHeight] = useState(() => {
    const width = getStoredNumber(
      TOOL_BROWSER_PANEL_WIDTH_STORAGE_KEY,
      DEFAULT_TOOL_BROWSER_PANEL_WIDTH,
    );
    return toolBrowserPanelHeightForWidth(
      Number.isFinite(width) ? clampToolBrowserPanelWidth(width, DEFAULT_SIDEBAR_WIDTH) : DEFAULT_TOOL_BROWSER_PANEL_WIDTH,
    );
  });
  const [agentDrawerWidth, setAgentDrawerWidth] = useState(() => {
    const value = getStoredNumber(
      AGENT_DRAWER_WIDTH_STORAGE_KEY,
      DEFAULT_AGENT_DRAWER_WIDTH,
    );
    return Number.isFinite(value)
      ? Math.min(maxAgentDrawerWidth(DEFAULT_SIDEBAR_WIDTH), Math.max(MIN_AGENT_DRAWER_WIDTH, value))
      : DEFAULT_AGENT_DRAWER_WIDTH;
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const value = getStoredNumber(
      SIDEBAR_WIDTH_STORAGE_KEY,
      DEFAULT_SIDEBAR_WIDTH,
    );
    return Number.isFinite(value)
      ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
      : DEFAULT_SIDEBAR_WIDTH;
  });
  const rootComposerDraft = activeChannelId ? rootComposerDrafts[activeChannelId] ?? EMPTY_COMPOSER_DRAFT : EMPTY_COMPOSER_DRAFT;
  const replyComposerDraft = activeThreadId ? replyComposerDrafts[activeThreadId] ?? EMPTY_COMPOSER_DRAFT : EMPTY_COMPOSER_DRAFT;
  const draft = rootComposerDraft.text;
  const draftAttachments = rootComposerDraft.attachments;
  const replyDraft = replyComposerDraft.text;
  const replyAttachments = replyComposerDraft.attachments;

  useEffect(() => {
    if (!focusedMessageId) return;
    const timer = window.setTimeout(() => setFocusedMessageId(null), 2600);
    return () => window.clearTimeout(timer);
  }, [focusedMessageId]);

  useEffect(() => {
    function clampRightPanels() {
      const nextToolBrowserWidth = clampToolBrowserPanelWidth(toolBrowserPanelWidth, sidebarWidth);
      setThreadPanelWidth((current) => Math.min(maxThreadPanelWidth(sidebarWidth), current));
      setAgentDrawerWidth((current) => Math.min(maxAgentDrawerWidth(sidebarWidth), current));
      setToolBrowserPanelWidth(nextToolBrowserWidth);
      setToolBrowserPanelHeight(toolBrowserPanelHeightForWidth(nextToolBrowserWidth));
    }

    clampRightPanels();
    window.addEventListener("resize", clampRightPanels);
    return () => window.removeEventListener("resize", clampRightPanels);
  }, [sidebarWidth, toolBrowserPanelWidth]);

  const [channelAlertIds, setChannelAlertIds] = useState<Set<string>>(() => new Set());
  const [threadUnreadCounts, setThreadUnreadCounts] = useState<Record<string, number>>({});
  const [dismissedActivityFeedItems, setDismissedActivityFeedItems] = useState<Record<string, string>>({});
  const [readActivityFeedItems, setReadActivityFeedItems] = useState<Record<string, string>>({});
  const [locallyUnfollowedThreadIds, setLocallyUnfollowedThreadIds] = useState<Set<string>>(() => new Set());
  const refreshMetricsRef = useRef<RefreshMetrics>(createRefreshMetrics());
  const knownMessageIdsRef = useRef<Set<string> | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRequestRef = useRef<RefreshRequest | null>(null);
  const pendingRefreshRequestRef = useRef<RefreshRequest | null>(null);
  const backendEventsConnectedRef = useRef(false);
  const lastFullRefreshAtRef = useRef(0);
  const messageDeltaBufferRef = useRef<Map<string, { append: string; deliveryState: Message["delivery_state"]; reason: string }>>(new Map());
  const optimisticMessagesRef = useRef<Map<string, Message>>(new Map());
  const optimisticAttachmentUrlsRef = useRef<Map<string, string[]>>(new Map());
  const messageDeltaFlushTimerRef = useRef<number | null>(null);
  const ephemeralActivityBufferRef = useRef<Map<string, EphemeralActivityBufferItem>>(new Map());
  const ephemeralRunBufferRef = useRef<Map<string, EphemeralRunBufferItem>>(new Map());
  const ephemeralFlushScheduledRef = useRef(false);
  const ephemeralFlushRafRef = useRef<number | null>(null);
  const ephemeralFlushTimerRef = useRef<number | null>(null);
  const appHistoryReadyRef = useRef(false);
  const appHistoryIndexRef = useRef(0);
  const appHistoryMaxIndexRef = useRef(0);
  const restoringAppHistoryRef = useRef(false);
  const replaceNextAppHistoryEntryRef = useRef(false);
  const lastAppHistoryKeyRef = useRef<string | null>(null);
  const searchResultThreadIdRef = useRef<string | null>(null);
  const searchResultAgentIdRef = useRef<string | null>(null);
  const appShellRef = useRef<HTMLElement | null>(null);
  const [appHistoryIndex, setAppHistoryIndex] = useState(0);
  const [appHistoryMaxIndex, setAppHistoryMaxIndex] = useState(0);
  const activeMobileModal: MobileModal | null = showSearchModal
    ? "search"
    : showActivityFeedModal
      ? "activity"
      : showSavedModal
        ? "saved"
        : null;
  const refreshMetricsSnapshotForUi = showDiagnosticsModal ? refreshMetricsSnapshot(refreshMetricsRef.current) : null;

  useEffect(() => {
    return () => {
      optimisticAttachmentUrlsRef.current.forEach((objectUrls) => {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
      });
      optimisticAttachmentUrlsRef.current.clear();
      optimisticMessagesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!showDiagnosticsModal) return;
    setRefreshMetricsTick((current) => current + 1);
    const timer = window.setInterval(() => {
      setRefreshMetricsTick((current) => current + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showDiagnosticsModal]);

  useEffect(() => {
    if (searchResultAgentIdRef.current && searchResultAgentIdRef.current !== selectedAgentId) {
      searchResultAgentIdRef.current = null;
    }
  }, [selectedAgentId]);

  useEffect(() => {
    function handleToolBrowserToggle(event: Event) {
      if (!isToolBrowserToggleEvent(event)) return;
      const target = event.detail.target;
      saveToolBrowserTarget(target);
      setToolBrowserTarget((current) => current === target ? null : target);
    }

    window.addEventListener(TOOL_BROWSER_TOGGLE_EVENT, handleToolBrowserToggle);
    return () => window.removeEventListener(TOOL_BROWSER_TOGGLE_EVENT, handleToolBrowserToggle);
  }, []);

  useEffect(() => {
    if (searchResultThreadIdRef.current && searchResultThreadIdRef.current !== activeThreadId) {
      searchResultThreadIdRef.current = null;
    }
  }, [activeThreadId]);

  function clearSearchResultAgentProvenance(agentId: string | null) {
    if (agentId && searchResultAgentIdRef.current === agentId) {
      searchResultAgentIdRef.current = null;
    }
  }

  function clearSearchResultThreadProvenance(threadId: string | null) {
    if (threadId && searchResultThreadIdRef.current === threadId) {
      searchResultThreadIdRef.current = null;
    }
  }

  function openAgentDetail(agentId: string) {
    clearSearchResultAgentProvenance(agentId);
    setSelectedAgentId(agentId);
  }

  function setAppHistoryPosition(index: number, maxIndex?: number) {
    const nextMaxIndex = maxIndex ?? Math.max(appHistoryMaxIndexRef.current, index);
    appHistoryIndexRef.current = index;
    appHistoryMaxIndexRef.current = nextMaxIndex;
    setAppHistoryIndex(index);
    setAppHistoryMaxIndex(nextMaxIndex);
  }

  function buildAppHistoryState(index = appHistoryIndexRef.current): AppHistoryState {
    return {
      __lantorUiHistory: true,
      __lantorMobileUi: true,
      index,
      activeChannelId: activeChannelId || null,
      activeThreadId,
      activeTab,
      showThread,
      showMobileSidebar,
      selectedAgentId,
      activeModal: activeMobileModal,
    };
  }

  async function refreshRuntimeChecks() {
    if (!isTauriRuntime()) {
      setRuntimeChecks({});
      return;
    }
    const entries = await Promise.all(
      Object.keys(RUNTIME_PRESETS).map(async (runtime) => {
        const check = await apiInvoke<RuntimeCheck>("check_runtime", { runtime });
        return [runtime, check] as const;
      }),
    );
    setRuntimeChecks(Object.fromEntries(entries));
  }

  function sortedMessages(messages: Message[]) {
    return [...messages].sort((left, right) => timestampMs(left.created_at) - timestampMs(right.created_at));
  }

  function mergeMessages(existing: Message[], incoming: Message[]) {
    if (incoming.length === 0) return existing;
    const byId = new Map(existing.map((message) => [message.id, message] as const));
    for (const message of incoming) byId.set(message.id, message);
    return sortedMessages(Array.from(byId.values()));
  }

  function normalizeBootstrap(next: Bootstrap): Bootstrap {
    return {
      ...next,
      messages: sortedMessages(next.messages),
      thread_activities: next.thread_activities ?? [],
      agent_work_items: retainWorkItemsForUi(next.agent_work_items ?? []),
      call_sessions: next.call_sessions ?? [],
      call_utterances: next.call_utterances ?? [],
      call_dispatches: next.call_dispatches ?? [],
      agent_activities: limitActivitiesPerAgent(next.agent_activities),
    };
  }

  function publishRefreshMetrics() {
    window.__LANTOR_REFRESH_METRICS__ = refreshMetricsSnapshot(refreshMetricsRef.current);
  }

  function writeRefreshMetric(metric: Record<string, unknown>) {
    void apiInvoke("record_ui_refresh_metric", { metric }).catch((err) => {
      console.warn("Failed to write Lantor refresh metric", err);
    });
  }

  function normalizeRefreshRequest(request: Partial<RefreshRequest> | string = {}): RefreshRequest {
    if (typeof request === "string") {
      return {
        reason: "scheduled_refresh",
        source: "legacy_call",
        fallback: request,
        includeOptimistic: true,
      };
    }
    return {
      reason: request.reason ?? "manual",
      source: request.source ?? "direct",
      fallback: request.fallback ?? `Failed to refresh ${APP_DISPLAY_NAME} state`,
      includeOptimistic: request.includeOptimistic ?? true,
      preferredActiveChannelId: request.preferredActiveChannelId,
    };
  }

  function resetRefreshMetrics() {
    refreshMetricsRef.current = createRefreshMetrics();
    publishRefreshMetrics();
    setRefreshMetricsTick((current) => current + 1);
  }

  function recordRefreshRequest(request: RefreshRequest) {
    const metrics = refreshMetricsRef.current;
    metrics.requestCount += 1;
    incrementMetric(metrics.requestByReason, request.reason);
    publishRefreshMetrics();
  }

  function recordCoalescedRefreshRequest(request: RefreshRequest) {
    const metrics = refreshMetricsRef.current;
    metrics.coalescedRequestCount += 1;
    incrementMetric(metrics.coalescedRequestByReason, request.reason);
    publishRefreshMetrics();
  }

  function recordQueuedRefreshRequest(request: RefreshRequest) {
    const metrics = refreshMetricsRef.current;
    metrics.queuedRequestCount += 1;
    incrementMetric(metrics.queuedRequestByReason, request.reason);
    publishRefreshMetrics();
  }

  function recordStateUpdate(reason: string) {
    const metrics = refreshMetricsRef.current;
    metrics.stateUpdateCount += 1;
    incrementMetric(metrics.stateUpdateByReason, reason);
    publishRefreshMetrics();
  }

  function recordBootstrapRefresh(request: RefreshRequest, durationMs: number) {
    const metrics = refreshMetricsRef.current;
    const now = Date.now();
    const previousBootstrapAt = metrics.lastBootstrapAt;
    metrics.bootstrapCount += 1;
    metrics.lastBootstrapAt = now;
    metrics.lastBootstrapReason = request.reason;
    incrementMetric(metrics.bootstrapByReason, request.reason);
    incrementMetric(metrics.bootstrapBySource, request.source);
    publishRefreshMetrics();
    const metric = {
      type: "bootstrap",
      count: metrics.bootstrapCount,
      reason: request.reason,
      source: request.source,
      durationMs: Number(durationMs.toFixed(1)),
      intervalMs: previousBootstrapAt === null ? null : now - previousBootstrapAt,
      perMinute: metricRatePerMinute(metrics.bootstrapCount, metrics.startedAt, now),
    };
    console.info("[lantor-refresh] bootstrap", metric);
    writeRefreshMetric(metric);
  }

  function logRefreshMetricsSummary(label = "periodic") {
    const metrics = refreshMetricsRef.current;
    const now = Date.now();
    metrics.lastSummaryAt = now;
    publishRefreshMetrics();
    const metric = {
      type: "summary",
      label,
      uptimeMs: now - metrics.startedAt,
      bootstrap: {
        count: metrics.bootstrapCount,
        perMinute: metricRatePerMinute(metrics.bootstrapCount, metrics.startedAt, now),
        byReason: topMetricEntries(metrics.bootstrapByReason),
        bySource: topMetricEntries(metrics.bootstrapBySource),
        lastReason: metrics.lastBootstrapReason,
      },
      requests: {
        count: metrics.requestCount,
        coalesced: metrics.coalescedRequestCount,
        queued: metrics.queuedRequestCount,
        byReason: topMetricEntries(metrics.requestByReason),
        coalescedByReason: topMetricEntries(metrics.coalescedRequestByReason),
        queuedByReason: topMetricEntries(metrics.queuedRequestByReason),
      },
      stateUpdates: {
        count: metrics.stateUpdateCount,
        perMinute: metricRatePerMinute(metrics.stateUpdateCount, metrics.startedAt, now),
        byReason: topMetricEntries(metrics.stateUpdateByReason),
      },
    };
    console.info("[lantor-refresh] summary", metric);
    writeRefreshMetric(metric);
  }

  async function refresh(request: Partial<RefreshRequest> | boolean = {}) {
    const normalizedRequest = typeof request === "boolean"
      ? normalizeRefreshRequest({ includeOptimistic: request })
      : normalizeRefreshRequest(request);
    const startedAt = performance.now();
    const next = normalizeBootstrap(await apiInvoke<Bootstrap>("bootstrap"));
    recordBootstrapRefresh(normalizedRequest, performance.now() - startedAt);
    lastFullRefreshAtRef.current = Date.now();
    const refreshed = normalizedRequest.includeOptimistic ? withOptimisticMessages(next) : next;
    setData((current) => current
      ? { ...refreshed, messages: mergeMessages(current.messages, refreshed.messages) }
      : refreshed);
    setActiveChannelId((prev) => {
      if (normalizedRequest.preferredActiveChannelId && next.channels.some((item) => item.id === normalizedRequest.preferredActiveChannelId)) {
        return normalizedRequest.preferredActiveChannelId;
      }
      if (next.channels.some((item) => item.id === prev)) return prev;
      return next.channels[0]?.id || "";
    });
    setActiveThreadId((prev) => {
      // Bootstrap now carries only a recent message window; keep the selected
      // thread and let dynamic thread fetch hydrate it if it is outside that window.
      if (prev) return prev;
      return null;
    });
  }

  function refreshWithError(request: RefreshRequest | string) {
    const normalizedRequest = typeof request === "string" ? normalizeRefreshRequest(request) : request;
    if (refreshInFlightRef.current) {
      refreshQueuedRequestRef.current = normalizedRequest;
      recordQueuedRefreshRequest(normalizedRequest);
      return;
    }
    refreshInFlightRef.current = true;
    refresh(normalizedRequest)
      .catch((err) => {
        setAppError(errorMessage(err, normalizedRequest.fallback));
        console.error(err);
      })
      .finally(() => {
        refreshInFlightRef.current = false;
        if (refreshQueuedRequestRef.current) {
          const queuedRequest = refreshQueuedRequestRef.current;
          refreshQueuedRequestRef.current = null;
          requestRefresh(queuedRequest);
        }
      });
  }

  function requestRefresh(request: Partial<RefreshRequest> | string = {}) {
    const normalizedRequest = normalizeRefreshRequest(request);
    recordRefreshRequest(normalizedRequest);
    if (refreshTimerRef.current !== null) {
      recordCoalescedRefreshRequest(normalizedRequest);
      return;
    }
    pendingRefreshRequestRef.current = normalizedRequest;
    refreshTimerRef.current = window.setTimeout(() => {
      const pendingRequest = pendingRefreshRequestRef.current ?? normalizedRequest;
      pendingRefreshRequestRef.current = null;
      refreshTimerRef.current = null;
      refreshWithError(pendingRequest);
    }, UI_REFRESH_DEBOUNCE_MS);
  }

  async function fetchMessagesOnce(
    key: string,
    args: { channelId?: string; threadRootId?: string; before?: string; limit?: number; rootOnly?: boolean },
  ) {
    if (messageLoadKeysRef.current.has(key) || messageLoadInFlightRef.current.has(key)) return;
    messageLoadInFlightRef.current.add(key);
    try {
      const messages = await apiInvoke<Message[]>("fetch_messages", args);
      messageLoadKeysRef.current.add(key);
      if (messages.length === 0) return;
      setData((current) => current
        ? { ...current, messages: mergeMessages(current.messages, messages) }
        : current);
    } catch (err) {
      console.error("Failed to dynamically fetch messages", err);
    } finally {
      messageLoadInFlightRef.current.delete(key);
    }
  }

  function withOptimisticMessages(next: Bootstrap): Bootstrap {
    if (optimisticMessagesRef.current.size === 0) return next;
    const existingIds = new Set(next.messages.map((message) => message.id));
    const optimisticMessages = Array.from(optimisticMessagesRef.current.values())
      .filter((message) => !existingIds.has(message.id));
    if (optimisticMessages.length === 0) return next;
    return { ...next, messages: sortedMessages([...next.messages, ...optimisticMessages]) };
  }

  function flushMessageDeltas() {
    if (messageDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(messageDeltaFlushTimerRef.current);
      messageDeltaFlushTimerRef.current = null;
    }
    if (messageDeltaBufferRef.current.size === 0) return;
    const deltas = messageDeltaBufferRef.current;
    messageDeltaBufferRef.current = new Map();
    const deltaReasons = new Set(Array.from(deltas.values()).map((delta) => delta.reason));
    recordStateUpdate(deltaReasons.size === 1 ? (deltaReasons.values().next().value ?? "message_delta") : "message_delta:mixed");
    setData((current) => {
      if (!current) {
        requestRefresh({
          reason: "message_delta:missing_local_data",
          source: "backend_event",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after message delta`,
        });
        return current;
      }
      let missing = false;
      let changed = false;
      const messages = current.messages.map((item) => {
        const delta = deltas.get(item.id);
        if (!delta) return item;
        changed = true;
        return { ...item, body: `${item.body}${delta.append}`, delivery_state: delta.deliveryState };
      });
      for (const messageId of deltas.keys()) {
        if (!current.messages.some((item) => item.id === messageId)) {
          missing = true;
          break;
        }
      }
      if (missing) {
        // The matching stream_start/message_upsert can arrive after a delta on
        // slow SSE connections. Avoid a full bootstrap here; stream_finish will
        // upsert the complete message if the start event was missed.
        return current;
      }
      if (!changed) return current;
      return { ...current, messages };
    });
  }

  function queueMessageDelta(messageId: string, append: string, deliveryState: Message["delivery_state"], reason: string) {
    const existing = messageDeltaBufferRef.current.get(messageId);
    messageDeltaBufferRef.current.set(messageId, {
      append: `${existing?.append ?? ""}${append}`,
      deliveryState,
      reason,
    });
    if (messageDeltaFlushTimerRef.current !== null) return;
    messageDeltaFlushTimerRef.current = window.setTimeout(() => {
      flushMessageDeltas();
    }, 50);
  }

  function cancelEphemeralFlushTimers() {
    if (ephemeralFlushRafRef.current !== null) {
      window.cancelAnimationFrame(ephemeralFlushRafRef.current);
      ephemeralFlushRafRef.current = null;
    }
    if (ephemeralFlushTimerRef.current !== null) {
      window.clearTimeout(ephemeralFlushTimerRef.current);
      ephemeralFlushTimerRef.current = null;
    }
    ephemeralFlushScheduledRef.current = false;
  }

  function bufferedStateUpdateReason(reasons: Set<string>, fallback: string) {
    return reasons.size === 1 ? (reasons.values().next().value ?? fallback) : fallback;
  }

  function flushEphemeralBuffer() {
    cancelEphemeralFlushTimers();
    const activityItems = Array.from(ephemeralActivityBufferRef.current.values());
    const runItems = Array.from(ephemeralRunBufferRef.current.values());
    if (activityItems.length === 0 && runItems.length === 0) return;
    ephemeralActivityBufferRef.current = new Map();
    ephemeralRunBufferRef.current = new Map();

    const reasons = new Set([
      ...activityItems.map((item) => item.reason),
      ...runItems.map((item) => item.reason),
    ]);
    recordStateUpdate(bufferedStateUpdateReason(reasons, "backend_event:ephemeral_batch"));

    setData((current) => {
      if (!current) {
        requestRefresh({
          reason: "backend_event:ephemeral:missing_local_data",
          source: "backend_event",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after buffered updates`,
        });
        return current;
      }

      let nextActivities = current.agent_activities;
      if (activityItems.length > 0) {
        const byId = new Map(nextActivities.map((item) => [item.id, item] as const));
        for (const item of activityItems) byId.set(item.activity.id, item.activity);
        nextActivities = limitActivitiesPerAgent(Array.from(byId.values()));
      }

      let nextRuns = current.agent_runs;
      if (runItems.length > 0) {
        const byId = new Map(nextRuns.map((item) => [item.id, item] as const));
        for (const item of runItems) {
          const patch = item.run;
          const existing = byId.get(patch.id);
          const run: AgentRun = {
            ...patch,
            log: patch.log ?? existing?.log ?? "",
          };
          byId.set(patch.id, existing ? { ...existing, ...run } : run);
        }
        nextRuns = Array.from(byId.values())
          .sort((left, right) => timestampMs(right.started_at) - timestampMs(left.started_at))
          .slice(0, 30);
      }

      if (nextActivities === current.agent_activities && nextRuns === current.agent_runs) {
        return current;
      }
      return { ...current, agent_activities: nextActivities, agent_runs: nextRuns };
    });
  }

  function scheduleEphemeralFlush() {
    if (ephemeralFlushScheduledRef.current) return;
    ephemeralFlushScheduledRef.current = true;
    ephemeralFlushRafRef.current = window.requestAnimationFrame(() => {
      ephemeralFlushRafRef.current = null;
      flushEphemeralBuffer();
    });
    ephemeralFlushTimerRef.current = window.setTimeout(() => {
      flushEphemeralBuffer();
    }, EPHEMERAL_FLUSH_FALLBACK_MS);
  }

  function bufferActivityEphemeral(activity: AgentActivity, reason: string) {
    ephemeralActivityBufferRef.current.set(activity.id, { activity, reason });
    scheduleEphemeralFlush();
  }

  function bufferRunEphemeral(run: Omit<AgentRun, "log"> & { log?: string }, reason: string) {
    ephemeralRunBufferRef.current.set(run.id, { run, reason });
    scheduleEphemeralFlush();
  }

  function dropPendingRunEphemeral(runId: string) {
    ephemeralRunBufferRef.current.delete(runId);
  }

  function collectBackendEvents(event: UiBackendEvent, events: FlatUiBackendEvent[]) {
    if (event.type !== "batch") {
      events.push(event);
      return;
    }
    for (const eventPayload of event.events) {
      collectBackendEvents(JSON.parse(eventPayload) as UiBackendEvent, events);
    }
  }

  function applyBackendStateEvents(events: FlatUiBackendEvent[]) {
    const stateEvents = events.filter((event) =>
      event.type === "message_upsert"
      || event.type === "message_delete"
      || event.type === "agent_upsert"
      || event.type === "activity_upsert"
      || event.type === "agent_run_upsert"
      || event.type === "work_item_upsert"
      || event.type === "call_session_upsert"
      || event.type === "call_utterance_upsert"
      || event.type === "call_dispatch_upsert"
      || event.type === "artifact_upsert");
    if (stateEvents.length === 0) return;

    const reasons = new Set(stateEvents.map((event) => event.reason ?? event.type));
    recordStateUpdate(reasons.size === 1 ? (reasons.values().next().value ?? "backend_event") : "backend_event:batch");

    setData((current) => {
      if (!current) {
        requestRefresh({
          reason: "backend_event:batch:missing_local_data",
          source: "backend_event",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after backend update`,
        });
        return current;
      }

      let messages = current.messages;
      let agents = current.agents;
      let agentActivities = current.agent_activities;
      let agentRuns = current.agent_runs;
      let agentWorkItems = current.agent_work_items;
      let callSessions = current.call_sessions ?? [];
      let callUtterances = current.call_utterances ?? [];
      let callDispatches = current.call_dispatches ?? [];
      let artifacts = Array.isArray(current.artifacts) ? current.artifacts : [];
      let messagesChanged = false;
      let agentsChanged = false;
      let activitiesChanged = false;
      let runsChanged = false;
      let workItemsChanged = false;
      let callSessionsChanged = false;
      let callUtterancesChanged = false;
      let callDispatchesChanged = false;
      let artifactsChanged = false;

      for (const event of stateEvents) {
        if (event.type === "agent_upsert") {
          agents = agents.some((item) => item.id === event.agent.id)
            ? agents.map((item) => item.id === event.agent.id ? event.agent : item)
            : [...agents, event.agent];
          agentsChanged = true;
        } else if (event.type === "message_upsert") {
          messageDeltaBufferRef.current.delete(event.message.id);
          const existingIndex = messages.findIndex((item) => item.id === event.message.id);
          messages = existingIndex >= 0
            ? messages.map((item) => item.id === event.message.id ? event.message : item)
            : [...messages, event.message];
          messagesChanged = true;
        } else if (event.type === "message_delete") {
          messageDeltaBufferRef.current.delete(event.message_id);
          messages = messages.filter((item) => item.id !== event.message_id);
          messagesChanged = true;
        } else if (event.type === "activity_upsert") {
          const existingIndex = agentActivities.findIndex((item) => item.id === event.activity.id);
          agentActivities = existingIndex >= 0
            ? agentActivities.map((item) => item.id === event.activity.id ? event.activity : item)
            : [event.activity, ...agentActivities];
          activitiesChanged = true;
        } else if (event.type === "agent_run_upsert") {
          const patch = event.run;
          const existing = agentRuns.find((item) => item.id === patch.id);
          const run: AgentRun = {
            ...patch,
            log: patch.log ?? existing?.log ?? "",
          };
          agentRuns = existing
            ? agentRuns.map((item) => item.id === patch.id ? { ...item, ...run } : item)
            : [run, ...agentRuns];
          runsChanged = true;
        } else if (event.type === "work_item_upsert") {
          const patch = event.work_item;
          const existing = agentWorkItems.find((item) => item.id === patch.id);
          const workItem: AgentWorkItem = {
            ...patch,
            context: patch.context ?? existing?.context ?? "",
            result_body: patch.result_body ?? existing?.result_body ?? "",
            source_kind: patch.source_kind ?? existing?.source_kind ?? "manual",
          };
          agentWorkItems = existing
            ? agentWorkItems.map((item) => item.id === patch.id ? { ...item, ...workItem } : item)
            : [workItem, ...agentWorkItems];
          workItemsChanged = true;
        } else if (event.type === "call_session_upsert") {
          const session = event.session;
          callSessions = callSessions.some((item) => item.id === session.id)
            ? callSessions.map((item) => item.id === session.id ? session : item)
            : [session, ...callSessions];
          callSessionsChanged = true;
        } else if (event.type === "call_utterance_upsert") {
          const utterance = event.utterance;
          callUtterances = callUtterances.some((item) => item.id === utterance.id)
            ? callUtterances.map((item) => item.id === utterance.id ? utterance : item)
            : [...callUtterances, utterance];
          callUtterancesChanged = true;
        } else if (event.type === "call_dispatch_upsert") {
          const dispatch = event.dispatch;
          callDispatches = callDispatches.some((item) => item.id === dispatch.id)
            ? callDispatches.map((item) => item.id === dispatch.id ? dispatch : item)
            : [...callDispatches, dispatch];
          callDispatchesChanged = true;
        } else if (event.type === "artifact_upsert") {
          const artifact = event.artifact;
          if (!artifact || typeof artifact.id !== "string" || typeof artifact.message_id !== "string") {
            requestRefresh({
              reason: `${event.reason ?? event.type}:invalid_payload`,
              source: "backend_event",
              fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after artifact update`,
            });
            continue;
          }
          const existingIndex = artifacts.findIndex((item) => item.id === artifact.id);
          artifacts = existingIndex >= 0
            ? artifacts.map((item) => item.id === artifact.id ? artifact : item)
            : [...artifacts, artifact];
          artifactsChanged = true;
          messages = messages.map((message) => {
            if (message.id !== artifact.message_id) return message;
            const currentMessageArtifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
            const existingArtifactIndex = currentMessageArtifacts.findIndex((item) => item.id === artifact.id);
            const messageArtifacts = existingArtifactIndex >= 0
              ? currentMessageArtifacts.map((item) => item.id === artifact.id ? artifact : item)
              : [...currentMessageArtifacts, artifact];
            return { ...message, artifacts: messageArtifacts };
          });
          messagesChanged = true;
        }
      }

      const next = {
        ...current,
        ...(messagesChanged ? { messages: sortedMessages(messages) } : null),
        ...(agentsChanged ? { agents } : null),
        ...(activitiesChanged ? { agent_activities: limitActivitiesPerAgent(agentActivities) } : null),
        ...(runsChanged
          ? {
              agent_runs: [...agentRuns]
                .sort((left, right) => timestampMs(right.started_at) - timestampMs(left.started_at))
                .slice(0, 30),
            }
          : null),
        ...(workItemsChanged
          ? {
              agent_work_items: retainWorkItemsForUi(agentWorkItems),
            }
          : null),
        ...(callSessionsChanged
          ? {
              call_sessions: [...callSessions]
                .sort((left, right) => new Date(right.started_at).getTime() - new Date(left.started_at).getTime()),
            }
          : null),
        ...(callUtterancesChanged
          ? {
              call_utterances: [...callUtterances]
                .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()),
            }
          : null),
        ...(callDispatchesChanged
          ? {
              call_dispatches: [...callDispatches]
                .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime()),
            }
          : null),
        ...(artifactsChanged ? { artifacts } : null),
      };
      return next;
    });
  }

  async function openArtifact(artifact: Artifact) {
    try {
      const fullArtifact = await apiInvoke<Artifact>("artifact_read", { artifactId: artifact.id });
      const blob = new Blob([fullArtifact.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setAppError(errorMessage(err, "Failed to open artifact"));
    }
  }

  function handleBackendEvent(payload: unknown) {
    try {
      if (typeof payload !== "string") {
        requestRefresh({
          reason: "backend_event:non_string_payload",
          source: "backend_event",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after backend update`,
        });
        return;
      }
      const parsed = JSON.parse(payload) as UiBackendEvent;
      const events: FlatUiBackendEvent[] = [];
      collectBackendEvents(parsed, events);
      const immediateStateEvents: FlatUiBackendEvent[] = [];
      for (const event of events) {
        const eventReason = event.reason ?? event.type;
        switch (event.type) {
          case "refresh":
            if (event.reason?.startsWith("long_task")) {
              setLongTaskRefreshNonce((current) => current + 1);
              requestRefresh({
                reason: eventReason,
                source: "backend_event",
                fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after long task update`,
              });
            } else {
              requestRefresh({
                reason: eventReason,
                source: "backend_event",
                fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after backend update`,
              });
            }
            break;
          case "message_delta":
            queueMessageDelta(event.message_id, event.append, event.delivery_state, eventReason);
            break;
          case "activity_upsert":
            bufferActivityEphemeral(event.activity, eventReason);
            break;
          case "agent_run_upsert":
            if (RUN_TERMINAL_STATUSES.has(event.run.status)) {
              dropPendingRunEphemeral(event.run.id);
              immediateStateEvents.push(event);
            } else {
              bufferRunEphemeral(event.run, eventReason);
            }
            break;
          case "message_upsert":
          case "message_delete":
          case "agent_upsert":
          case "work_item_upsert":
          case "call_session_upsert":
          case "call_utterance_upsert":
          case "call_dispatch_upsert":
          case "artifact_upsert":
            immediateStateEvents.push(event);
            break;
          case "tool_browser_open":
            saveToolBrowserTarget(event.target);
            setToolBrowserTarget(event.target);
            break;
          default: {
            const unknownEventType = String((event as { type?: unknown }).type ?? "unknown");
            requestRefresh({
              reason: `backend_event:unknown:${unknownEventType}`,
              source: "backend_event",
              fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after backend update`,
            });
          }
        }
      }
      applyBackendStateEvents(immediateStateEvents);
    } catch (err) {
      setAppError(errorMessage(err, `Failed to apply ${APP_DISPLAY_NAME} backend update`));
      console.error(`Failed to apply ${APP_DISPLAY_NAME} backend update`, err, payload);
      requestRefresh({
        reason: "backend_event:parse_or_apply_error",
        source: "backend_event",
        fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after backend update`,
      });
    }
  }

  async function mutate<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      const result = await apiInvoke<T>(command, args);
      await refresh({ reason: `mutation:${command}`, source: "mutation" });
      return result;
    } catch (err) {
      const message = errorMessage(err, `${command} failed`);
      setAppError(message);
      console.error(err);
      throw err;
    }
  }

  useEffect(() => {
    refresh({
      reason: "initial_load",
      source: "startup",
      fallback: `Failed to load ${APP_DISPLAY_NAME} state`,
    }).catch((err) => {
      setAppError(errorMessage(err, `Failed to load ${APP_DISPLAY_NAME} state`));
      console.error(err);
    });
    refreshRuntimeChecks().catch((err) => {
      setAppError(errorMessage(err, "Failed to check local runtimes"));
      console.error(err);
    });
  }, []);

  useEffect(() => {
    if (!data || showOwnerProfileModal) return;
    setOwnerProfileDraft(ownerProfileToForm(data.owner_profile));
  }, [data?.owner_profile, showOwnerProfileModal]);

  useEffect(() => {
    const summaryTimer = window.setInterval(() => {
      logRefreshMetricsSummary();
    }, REFRESH_METRICS_SUMMARY_MS);
    return () => {
      logRefreshMetricsSummary("shutdown");
      window.clearInterval(summaryTimer);
    };
  }, []);

  useEffect(() => {
    function isFileDrag(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function preventFileNavigation(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
    }

    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    function connect() {
      if (disposed || unlisten) return;
      subscribeBackendEvents(handleBackendEvent, (state) => {
        backendEventsConnectedRef.current = state === "open";
        if (state === "open") {
          requestRefresh({
            reason: "backend_events_reconnect",
            source: "backend_event",
            fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after reconnect`,
          });
        }
      })
        .then((handler) => {
          if (disposed) {
            handler();
            return;
          }
          unlisten = handler;
        })
        .catch((err) => {
          if (disposed) return;
          setAppError(errorMessage(err, `Failed to subscribe to ${APP_DISPLAY_NAME} updates`));
          console.error(err);
        });
    }

    function disconnect() {
      unlisten?.();
      unlisten = null;
      backendEventsConnectedRef.current = false;
    }

    function onPageHide() {
      disconnect();
    }

    function onPageShow() {
      connect();
      requestRefresh({
        reason: "page_restore",
        source: "browser_lifecycle",
        fallback: `Failed to refresh ${APP_DISPLAY_NAME} state after page restore`,
      });
    }

    connect();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (messageDeltaFlushTimerRef.current !== null) {
        window.clearTimeout(messageDeltaFlushTimerRef.current);
      }
      cancelEphemeralFlushTimers();
      disconnect();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!backendEventsConnectedRef.current) {
        requestRefresh({
          reason: "poll_disconnected",
          source: "poll",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state`,
        });
        return;
      }
      if (Date.now() - lastFullRefreshAtRef.current >= BACKEND_CONNECTED_FULL_REFRESH_MS) {
        requestRefresh({
          reason: "poll_connected_full_refresh",
          source: "poll",
          fallback: `Failed to refresh ${APP_DISPLAY_NAME} state`,
        });
      }
    }, BACKEND_DISCONNECTED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const hiddenCallWorkItemIds = useMemo(() => {
    return new Set((data?.agent_work_items ?? [])
      .filter((item) => item.call_dispatch_id)
      .map((item) => item.id.toLowerCase()));
  }, [data?.agent_work_items]);

  const hiddenCallRunIds = useMemo(() => {
    return new Set((data?.agent_runs ?? [])
      .filter((run) => run.work_item_id && hiddenCallWorkItemIds.has(run.work_item_id.toLowerCase()))
      .map((run) => run.id.toLowerCase()));
  }, [data?.agent_runs, hiddenCallWorkItemIds]);

  const isHiddenCallWorkerMessage = useCallback((message: Message) => {
    if (message.sender_role === "owner" || message.sender_role === "system") return false;
    const streamPrefix = messageStreamPrefixUuid(message);
    if (!streamPrefix) return false;
    return hiddenCallRunIds.has(streamPrefix) || hiddenCallWorkItemIds.has(streamPrefix);
  }, [hiddenCallRunIds, hiddenCallWorkItemIds]);

  useEffect(() => {
    if (!data) return;
    if (!knownMessageIdsRef.current) {
      knownMessageIdsRef.current = new Set(data.messages
        .filter((message) => !isProgressOnlyMessage(message) && !isHiddenCallWorkerMessage(message))
        .map((message) => message.id));
      return;
    }

    const known = knownMessageIdsRef.current;
    const newMessages = data.messages.filter((message) =>
      message.sender_role !== "owner"
      && !isProgressOnlyMessage(message)
      && !isHiddenCallWorkerMessage(message)
      && !known.has(message.id)
    );
    if (newMessages.length === 0) return;
    newMessages.forEach((message) => known.add(message.id));

    setChannelAlertIds((current) => {
      let next: Set<string> | null = null;
      for (const message of newMessages) {
        if (message.channel_id === activeChannelId) continue;
        next ??= new Set(current);
        next.add(message.channel_id);
      }
      return next ?? current;
    });

    setThreadUnreadCounts((current) => {
      let next: Record<string, number> | null = null;
      for (const message of newMessages) {
        if (!message.thread_root_id || message.thread_root_id === activeThreadId) continue;
        next ??= { ...current };
        next[message.thread_root_id] = (next[message.thread_root_id] ?? 0) + 1;
      }
      return next ?? current;
    });
  }, [activeChannelId, activeThreadId, data, isHiddenCallWorkerMessage]);

  useEffect(() => {
    setThreadUnreadCounts(Object.fromEntries(
      (data?.thread_activities ?? [])
        .filter((activity) =>
          activity.unread_count > 0 &&
          activity.thread_root_id !== activeThreadId &&
          !isThreadActivityLocallyRead(activity))
        .map((activity) => [activity.thread_root_id, activity.unread_count]),
    ));
  }, [activeThreadId, data?.thread_activities, readActivityFeedItems]);

  useEffect(() => {
    if (!appError) return;
    const timer = window.setTimeout(() => setAppError(null), 6500);
    return () => window.clearTimeout(timer);
  }, [appError]);

  useEffect(() => {
    if (!data || !activeChannelId) return;
    void fetchMessagesOnce(`channel:${activeChannelId}:latest`, {
      channelId: activeChannelId,
      limit: CHANNEL_MESSAGE_PAGE_SIZE,
      rootOnly: true,
    });
  }, [activeChannelId, data]);

  useEffect(() => {
    if (!data || !activeThreadId) return;
    void fetchMessagesOnce(`thread:${activeThreadId}:latest`, {
      threadRootId: activeThreadId,
      limit: THREAD_MESSAGE_PAGE_SIZE,
    });
  }, [activeThreadId, data]);

  useEffect(() => {
    if (!activeChannelId) return;
    setChannelAlertIds((current) => {
      if (!current.has(activeChannelId)) return current;
      const next = new Set(current);
      next.delete(activeChannelId);
      return next;
    });
  }, [activeChannelId]);

  useEffect(() => {
    if (!activeThreadId) return;
    setThreadUnreadCounts((current) => {
      if (!current[activeThreadId]) return current;
      const next = { ...current };
      delete next[activeThreadId];
      return next;
    });
  }, [activeThreadId]);

  useEffect(() => {
    window.localStorage.setItem(THREAD_PANEL_WIDTH_STORAGE_KEY, String(threadPanelWidth));
  }, [threadPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(AGENT_DRAWER_WIDTH_STORAGE_KEY, String(agentDrawerWidth));
  }, [agentDrawerWidth]);

  useEffect(() => {
    window.localStorage.setItem(TOOL_BROWSER_PANEL_WIDTH_STORAGE_KEY, String(toolBrowserPanelWidth));
  }, [toolBrowserPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(CHANNEL_THREAD_MEMORY_STORAGE_KEY, JSON.stringify(channelThreadMemory));
  }, [channelThreadMemory]);

  useEffect(() => {
    window.localStorage.setItem(CHAT_TEXT_SIZE_STORAGE_KEY, chatTextSize);
  }, [chatTextSize]);

  useEffect(() => {
    setDismissedActivityFeedItems(data?.dismissed_inbox_items ?? {});
  }, [data?.dismissed_inbox_items]);

  useEffect(() => {
    setReadActivityFeedItems((current) => mergeInboxReadItems(current, data?.read_inbox_items ?? {}));
  }, [data?.read_inbox_items]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && (event.key === "=" || event.key === "+" || event.code === "Equal" || event.code === "NumpadAdd")) {
        event.preventDefault();
        setChatTextSize((current) => stepChatTextSize(current, 1));
        return;
      }

      if (modifier && (event.key === "-" || event.key === "_" || event.code === "Minus" || event.code === "NumpadSubtract")) {
        event.preventDefault();
        setChatTextSize((current) => stepChatTextSize(current, -1));
        return;
      }

      if (modifier && event.key === "0") {
        event.preventDefault();
        setChatTextSize("default");
        return;
      }

      if (modifier && (event.key === "," || event.code === "Comma")) {
        event.preventDefault();
        setShowMobileSidebar(false);
        setShowSettingsModal(true);
        return;
      }

      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearchModal();
        return;
      }

      if (modifier && event.key === "[") {
        event.preventDefault();
        navigateBack(() => {
          if (showSearchModal) setShowSearchModal(false);
          else if (showActivityFeedModal) setShowActivityFeedModal(false);
          else if (showSavedModal) setShowSavedModal(false);
          else if (selectedAgentId) setSelectedAgentId(null);
          else if (showThread) setShowThread(false);
        });
        return;
      }

      if (modifier && event.key === "]") {
        event.preventDefault();
        navigateForward();
        return;
      }

      const modalOpen =
        showCreateChannelModal ||
        showChannelSettingsModal ||
        showChannelAgentsModal ||
        showCreateAgentModal ||
        showSearchModal ||
        showActivityFeedModal ||
        showSavedModal ||
        showOwnerProfileModal ||
        showDiagnosticsModal ||
        showSettingsModal ||
        Boolean(editingAgentId);
      if (event.key === "Escape" && !modalOpen && !isTextInput(event.target)) {
        if (selectedAgentId) {
          setSelectedAgentId(null);
        } else if (showThread) {
          setShowThread(false);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeChannelId,
    editingAgentId,
    selectedAgentId,
    showChannelAgentsModal,
    showChannelSettingsModal,
    showCreateAgentModal,
    showCreateChannelModal,
    showDiagnosticsModal,
    showSettingsModal,
    showActivityFeedModal,
    showOwnerProfileModal,
    showSavedModal,
    showSearchModal,
    showThread,
  ]);

  const channel = useMemo(() => {
    return data?.channels.find((c) => c.id === activeChannelId) ?? data?.channels[0] ?? null;
  }, [activeChannelId, data]);

  useEffect(() => {
    if (!data) return;
    function handleLocalHashNavigation() {
      const target = localTargetFromHash(window.location.hash);
      if (!target) return;
      openLocalLink(target);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }

    handleLocalHashNavigation();
    window.addEventListener("hashchange", handleLocalHashNavigation);
    return () => window.removeEventListener("hashchange", handleLocalHashNavigation);
  }, [data]);

  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      if (!isAppHistoryState(event.state)) return;
      if (isMobileViewport()) {
        window.history.replaceState(null, "");
        appHistoryReadyRef.current = false;
        setAppHistoryPosition(0, 0);
        lastAppHistoryKeyRef.current = null;
        return;
      }
      restoringAppHistoryRef.current = true;
      appHistoryReadyRef.current = true;
      setAppHistoryPosition(event.state.index);
      const activeChannelIdFromState = event.state.activeChannelId ?? null;
      const activeThreadIdFromState = event.state.activeThreadId ?? null;
      const activeTabFromState = event.state.activeTab ?? "chat";
      lastAppHistoryKeyRef.current = appHistoryKey({
        ...event.state,
        activeChannelId: activeChannelIdFromState,
        activeThreadId: activeThreadIdFromState,
        activeTab: activeTabFromState,
      });
      if (activeChannelIdFromState) {
        setActiveChannelId(activeChannelIdFromState);
        setActiveThreadId(activeThreadIdFromState);
        rememberChannelThread(activeChannelIdFromState, activeThreadIdFromState);
      }
      setActiveTab(activeTabFromState);
      setShowThread(event.state.showThread);
      setShowMobileSidebar(event.state.showMobileSidebar);
      setMobileSidebarDragPx(0);
      setSelectedAgentId(event.state.selectedAgentId);
      setShowSearchModal(event.state.activeModal === "search");
      setShowActivityFeedModal(event.state.activeModal === "activity");
      setShowSavedModal(event.state.activeModal === "saved");
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!data || !activeChannelId) return;
    if (isMobileViewport()) {
      if (isAppHistoryState(window.history.state)) {
        window.history.replaceState(null, "");
      }
      appHistoryReadyRef.current = false;
      replaceNextAppHistoryEntryRef.current = false;
      lastAppHistoryKeyRef.current = null;
      setAppHistoryPosition(0, 0);
      return;
    }

    const currentState = buildAppHistoryState(appHistoryIndexRef.current);
    const currentKey = appHistoryKey(currentState);

    if (restoringAppHistoryRef.current) {
      restoringAppHistoryRef.current = false;
      lastAppHistoryKeyRef.current = currentKey;
      return;
    }

    if (!appHistoryReadyRef.current) {
      const existingState = window.history.state;
      if (isAppHistoryState(existingState)) {
        appHistoryReadyRef.current = true;
        setAppHistoryPosition(existingState.index);
        const nextState = buildAppHistoryState(existingState.index);
        window.history.replaceState(nextState, "");
        lastAppHistoryKeyRef.current = appHistoryKey(nextState);
        return;
      }

      const baseState: AppHistoryState = {
        ...currentState,
        index: 0,
      };
      const baseKey = appHistoryKey(baseState);
      window.history.replaceState(baseState, "");
      appHistoryReadyRef.current = true;
      setAppHistoryPosition(0, 0);
      lastAppHistoryKeyRef.current = baseKey;

      if (baseKey === currentKey) return;
      const firstState = { ...currentState, index: 1 };
      window.history.pushState(firstState, "");
      setAppHistoryPosition(1, 1);
      lastAppHistoryKeyRef.current = appHistoryKey(firstState);
      return;
    }

    if (lastAppHistoryKeyRef.current === currentKey) return;

    if (replaceNextAppHistoryEntryRef.current) {
      replaceNextAppHistoryEntryRef.current = false;
      const nextState = { ...currentState, index: appHistoryIndexRef.current };
      window.history.replaceState(nextState, "");
      setAppHistoryPosition(nextState.index);
      lastAppHistoryKeyRef.current = appHistoryKey(nextState);
      return;
    }

    const nextState = { ...currentState, index: appHistoryIndexRef.current + 1 };
    window.history.pushState(nextState, "");
    setAppHistoryPosition(nextState.index, nextState.index);
    lastAppHistoryKeyRef.current = appHistoryKey(nextState);
  }, [
    data,
    activeChannelId,
    activeThreadId,
    activeTab,
    selectedAgentId,
    activeMobileModal,
    showMobileSidebar,
    showThread,
  ]);

  useEffect(() => {
    const hasOpenModal = showChannelAgentsModal ||
      showChannelSettingsModal ||
      showCreateAgentModal ||
      showCreateChannelModal ||
      showActivityFeedModal ||
      showOwnerProfileModal ||
      showDiagnosticsModal ||
      showSavedModal ||
      showSearchModal;
    const isSidebarSwipe = activeMainView !== "channels" || (!showThread && !selectedAgentId);
    if (!isMobileViewport() || showMobileSidebar || hasOpenModal) return;

    let startX: number | null = null;
    let startY: number | null = null;
    let lastX = 0;
    let lastTime = 0;
    let tracking = false;

    function mobileSidebarWidth() {
      return window.innerWidth;
    }

    function resetSwipe() {
      startX = null;
      startY = null;
      lastX = 0;
      lastTime = 0;
      tracking = false;
      setMobileSidebarDragPx(0);
      setMobileDragSurface(null);
    }

    function onTouchStart(event: TouchEvent) {
      if (event.touches.length !== 1 || isTextInput(event.target) || isActionControl(event.target)) {
        resetSwipe();
        return;
      }

      const touch = event.touches[0];
      if (touch.clientX > MOBILE_EDGE_SWIPE_START_PX) {
        resetSwipe();
        return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = touch.clientX;
      lastTime = event.timeStamp;
      tracking = true;
      setMobileDragSurface(isSidebarSwipe ? "sidebar" : "panel");
      setMobileSidebarDragPx(MOBILE_SIDEBAR_PEEK_PX);
    }

    function onTouchMove(event: TouchEvent) {
      if (!tracking || startX === null || startY === null || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = Math.abs(touch.clientY - startY);

      if (deltaY > MOBILE_EDGE_SWIPE_MAX_VERTICAL_PX && Math.abs(deltaX) < MOBILE_EDGE_SWIPE_OPEN_PX) {
        resetSwipe();
        return;
      }
      if (Math.abs(deltaX) > 10) {
        event.preventDefault();
      }

      const width = mobileSidebarWidth();
      setMobileSidebarDragPx(Math.max(MOBILE_SIDEBAR_PEEK_PX, Math.min(width, deltaX)));
      lastX = touch.clientX;
    }

    function onTouchEnd(event: TouchEvent) {
      if (!tracking || startX === null) {
        resetSwipe();
        return;
      }

      const width = mobileSidebarWidth();
      const currentPx = Math.max(0, Math.min(width, lastX - startX));
      const elapsed = Math.max(1, event.timeStamp - lastTime);
      const velocity = (lastX - startX) / elapsed;
      const shouldOpen = currentPx >= width * 0.28 || velocity > MOBILE_SIDEBAR_FLING_VELOCITY;

      if (shouldOpen) {
        if (activeMainView === "channels" && selectedAgentId) {
          closeSelectedAgent();
        } else if (activeMainView === "channels" && showThread) {
          closeThreadPanel();
        } else {
          openMobileSidebarFromContent();
        }
      }
      resetSwipe();
    }

    window.addEventListener("touchstart", onTouchStart, { passive: false, capture: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    window.addEventListener("touchcancel", resetSwipe, { passive: true, capture: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
      window.removeEventListener("touchmove", onTouchMove, { capture: true });
      window.removeEventListener("touchend", onTouchEnd, { capture: true });
      window.removeEventListener("touchcancel", resetSwipe, { capture: true });
    };
  }, [
    activeMainView,
    activeThreadId,
    selectedAgentId,
    showChannelAgentsModal,
    showChannelSettingsModal,
    showCreateAgentModal,
    showCreateChannelModal,
    showActivityFeedModal,
    showDiagnosticsModal,
    showMobileSidebar,
    showOwnerProfileModal,
    showSavedModal,
    showSearchModal,
    showThread,
  ]);

  useEffect(() => {
    function onTouchStart(event: TouchEvent) {
      if (!isMobileViewport() || !isActionControl(event.target) || isTextInput(event.target)) return;
      if (event.target instanceof HTMLElement && event.target.closest(".composer, .reply-composer")) return;
      if (document.activeElement instanceof HTMLElement && isTextInput(document.activeElement)) {
        document.activeElement.blur();
      }
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart, { capture: true });
    };
  }, []);

  useEffect(() => {
    function updateComposerFocus() {
      const activeElement = document.activeElement;
      const isFocused = Boolean(
        isMobileViewport()
          && activeElement instanceof HTMLElement
          && activeElement.closest(".composer, .reply-composer"),
      );
      setMobileComposerFocused((current) => current === isFocused ? current : isFocused);
    }

    function onFocusOut() {
      window.requestAnimationFrame(updateComposerFocus);
    }

    window.addEventListener("focusin", updateComposerFocus);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", updateComposerFocus);
    updateComposerFocus();
    return () => {
      window.removeEventListener("focusin", updateComposerFocus);
      window.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", updateComposerFocus);
    };
  }, []);

  const visibleMessages = useMemo(() => {
    return (data?.messages ?? [])
      .filter((message) => !isProgressOnlyMessage(message) && !isHiddenCallWorkerMessage(message));
  }, [data?.messages, isHiddenCallWorkerMessage]);

  const visibleMessageById = useMemo(() => {
    return new Map(visibleMessages.map((message) => [message.id, message]));
  }, [visibleMessages]);

  const threadActivityByRoot = useMemo(() => {
    return new Map((data?.thread_activities ?? []).map((activity) => [activity.thread_root_id, activity]));
  }, [data?.thread_activities]);

  const rootMessages = useMemo(() => {
    if (!channel) return [];
    return visibleMessages.filter((m) => m.channel_id === channel.id && !m.thread_root_id);
  }, [visibleMessages, channel]);

  function loadOlderRootMessages() {
    if (!channel || rootMessages.length === 0) return Promise.resolve();
    const oldestRoot = rootMessages[0];
    return fetchMessagesOnce(`channel:${channel.id}:roots:before:${oldestRoot.created_at}`, {
      channelId: channel.id,
      before: oldestRoot.created_at,
      limit: CHANNEL_MESSAGE_PAGE_SIZE,
      rootOnly: true,
    });
  }

  const activeRoot = activeThreadId ? rootMessages.find((m) => m.id === activeThreadId) ?? null : null;

  const replies = useMemo(() => {
    if (!activeRoot) return [];
    return visibleMessages.filter((m) => m.thread_root_id === activeRoot.id);
  }, [visibleMessages, activeRoot]);

  const threadReplySummaries = useMemo(() => {
    const summaries = visibleMessages.reduce<Record<string, ThreadReplySummary>>((items, message) => {
      if (!message.thread_root_id) return items;
      const current = items[message.thread_root_id] ?? { count: 0, latest: null, participants: [] };
      current.count += 1;
      if (!current.latest || new Date(message.created_at) > new Date(current.latest.created_at)) {
        current.latest = message;
      }
      if (
        message.sender_role !== "system" &&
        !current.participants.some((participant) =>
          participant.sender_role === message.sender_role &&
          participant.sender_name === message.sender_name &&
          participant.sender_agent_id === message.sender_agent_id)
      ) {
        current.participants.push(message);
      }
      items[message.thread_root_id] = current;
      return items;
    }, {});
    // Bootstrap thread activity is a fallback; live message upserts/deltas are authoritative.
    for (const activity of data?.thread_activities ?? []) {
      if (summaries[activity.thread_root_id]) continue;
      const current: ThreadReplySummary = { count: activity.reply_count, latest: null, participants: [] };
      const latest = activity.latest_visible_message_id
        ? visibleMessageById.get(activity.latest_visible_message_id) ?? null
        : null;
      if (latest) current.latest = latest;
      summaries[activity.thread_root_id] = current;
    }
    return summaries;
  }, [data?.thread_activities, visibleMessageById, visibleMessages]);

  const threadReplyCounts = useMemo(() => {
    return Object.fromEntries(
      Object.entries(threadReplySummaries).map(([rootId, summary]) => [rootId, summary.count]),
    );
  }, [threadReplySummaries]);

  const allThreadRootMessages = useMemo(() => {
    return visibleMessages
      .filter((message) =>
        !message.thread_root_id &&
        (threadActivityByRoot.has(message.id) || (threadReplyCounts[message.id] ?? 0) > 0) &&
        (message.thread_followed || (threadUnreadCounts[message.id] ?? 0) > 0) &&
        !locallyUnfollowedThreadIds.has(message.id))
      .sort((left, right) => {
        const rightLatest = threadReplySummaries[right.id]?.latest?.created_at ?? threadActivityByRoot.get(right.id)?.latest_visible_at;
        const leftLatest = threadReplySummaries[left.id]?.latest?.created_at ?? threadActivityByRoot.get(left.id)?.latest_visible_at;
        return timestampMs(rightLatest) - timestampMs(leftLatest);
      });
  }, [visibleMessages, locallyUnfollowedThreadIds, threadActivityByRoot, threadReplyCounts, threadReplySummaries, threadUnreadCounts]);

  const allActivityFeedItems = useMemo(() => {
    if (!data) return [];
    const channelsById = new Map(data.channels.map((item) => [item.id, item]));
    const agentsById = new Map(data.agents.map((item) => [item.id, item]));
    const latestByChannel = new Map<string, Message>();
    const repliesByRoot = new Map<string, Message[]>();

    for (const message of visibleMessages) {
      const currentChannelLatest = latestByChannel.get(message.channel_id);
      if (!currentChannelLatest || new Date(message.created_at) > new Date(currentChannelLatest.created_at)) {
        latestByChannel.set(message.channel_id, message);
      }
      if (message.thread_root_id) {
        const currentReplies = repliesByRoot.get(message.thread_root_id) ?? [];
        currentReplies.push(message);
        repliesByRoot.set(message.thread_root_id, currentReplies);
      }
    }
    for (const replies of repliesByRoot.values()) {
      replies.sort((left, right) => timestampMs(left.created_at) - timestampMs(right.created_at));
    }

    const channelLabel = (channelId: string | null) => {
      if (!channelId) return APP_DISPLAY_NAME;
      const target = channelsById.get(channelId);
      if (!target) return "Unknown";
      if (target.kind === "dm") {
        const agent = target.dm_agent_id ? agentsById.get(target.dm_agent_id) : null;
        return agent ? `@${agent.handle}` : "Direct message";
      }
      return `#${target.name}`;
    };
    const timestamp = (value: string | null | undefined) => value || new Date(0).toISOString();
    const items: ActivityFeedItem[] = [];
    const threadRootIdsForActivityFeed = new Set(allThreadRootMessages.map((message) => message.id));

    for (const channel of data.channels) {
      const unread = channel.unread_count > 0 || channelAlertIds.has(channel.id);
      if (!unread) continue;
      const latest = latestByChannel.get(channel.id);
      if (latest?.thread_root_id && threadRootIdsForActivityFeed.has(latest.thread_root_id)) continue;
      const dmAgent = channel.kind === "dm" && channel.dm_agent_id ? agentsById.get(channel.dm_agent_id) : null;
      items.push({
        id: `${channel.kind}:${channel.id}`,
        dismissId: `${channel.kind}:${channel.id}`,
        kind: channel.kind === "dm" ? "dm" : "channel",
        title: channel.kind === "dm" ? `DM with @${dmAgent?.handle ?? "agent"}` : `New activity in #${channel.name}`,
        excerpt: latest?.body ?? visibleChannelDescription(channel.description),
        surface: channel.kind === "dm" ? "Direct message" : `#${channel.name}`,
        actor: latest ? displayNameForSender(latest, data.owner_profile) : "",
        timestamp: timestamp(latest?.created_at),
        unread: true,
        actorAgentId: latest?.sender_agent_id ?? dmAgent?.id ?? null,
        actorRole: latest?.sender_role ?? (channel.kind === "dm" ? "agent" : null),
        channelId: channel.id,
        threadId: latest?.thread_root_id ?? null,
        messageId: latest?.id ?? null,
        taskId: null,
        reminderId: null,
        replyCount: latest?.thread_root_id ? (threadReplyCounts[latest.thread_root_id] ?? 0) : 0,
        newCount: channel.unread_count,
      });
    }

    for (const root of allThreadRootMessages) {
      const replies = repliesByRoot.get(root.id) ?? [];
      const unreadCount = threadUnreadCounts[root.id] ?? 0;
      const latestReply = threadReplySummaries[root.id]?.latest
        ?? (replies.length > 0 ? replies[replies.length - 1] : null);
      const currentMessage = latestReply ?? root;
      const unread = unreadCount > 0;
      items.push({
        id: `thread:${root.id}`,
        dismissId: `thread:${root.id}`,
        kind: "thread",
        title: firstLines(currentMessage.body, 1),
        excerpt: currentMessage.body,
        surface: channelLabel(root.channel_id),
        actor: displayNameForSender(currentMessage, data.owner_profile),
        timestamp: timestamp(currentMessage.created_at),
        unread,
        actorAgentId: currentMessage.sender_agent_id,
        actorRole: currentMessage.sender_role,
        channelId: root.channel_id,
        threadId: root.id,
        messageId: currentMessage.id,
        taskId: null,
        reminderId: null,
        replyCount: threadReplyCounts[root.id] ?? 0,
        newCount: unreadCount,
      });
    }

    visibleMessages
      .filter((message) => message.sender_role !== "owner" && messageMentionsOwner(message))
      .sort((left, right) => timestampMs(right.created_at) - timestampMs(left.created_at))
      .forEach((message) => {
        const rootId = message.thread_root_id ?? message.id;
        items.push({
          id: `mention:${message.id}`,
          dismissId: `mention:${message.id}`,
          kind: "mention",
          title: firstLines(message.body, 1),
          excerpt: message.body,
          surface: channelLabel(message.channel_id),
          actor: message.sender_name,
          timestamp: message.created_at,
          unread: channelAlertIds.has(message.channel_id) || (message.thread_root_id ? (threadUnreadCounts[message.thread_root_id] ?? 0) > 0 : false),
          actorAgentId: message.sender_agent_id,
          actorRole: message.sender_role,
          channelId: message.channel_id,
          threadId: rootId,
          messageId: message.id,
          taskId: null,
          reminderId: null,
          replyCount: threadReplyCounts[rootId] ?? 0,
          newCount: message.thread_root_id ? (threadUnreadCounts[message.thread_root_id] ?? 0) : 0,
        });
      });

    data.tasks
      .filter((task) => task.status !== "done")
      .forEach((task) => {
        items.push({
          id: `task:${task.id}`,
          dismissId: `task:${task.id}`,
          kind: "task",
          title: `Task #${task.number}: ${task.title}`,
          excerpt: task.assignee_name ? `Assigned to ${task.assignee_name}` : "Unassigned",
          surface: `#${task.channel_name}`,
          actor: task.status.replace("_", " "),
          timestamp: task.updated_at,
          unread: task.status === "in_review",
          channelId: task.channel_id,
          threadId: task.message_id,
          messageId: task.message_id,
          taskId: task.id,
          reminderId: null,
          replyCount: threadReplyCounts[task.message_id] ?? 0,
          newCount: 0,
        });
      });

    data.reminders
      .filter((reminder) => reminder.status === "fired")
      .forEach((reminder) => {
        items.push({
          id: `reminder:${reminder.id}`,
          dismissId: `reminder:${reminder.id}`,
          kind: "reminder",
          title: reminder.title,
          excerpt: reminder.note,
          surface: reminder.channel_id ? channelLabel(reminder.channel_id) : "Reminder",
          actor: "Reminder due",
          timestamp: reminder.fired_at ?? reminder.due_at,
          unread: true,
          channelId: reminder.channel_id,
          threadId: reminder.thread_root_id,
          messageId: reminder.message_id,
          taskId: null,
          reminderId: reminder.id,
          replyCount: reminder.thread_root_id ? (threadReplyCounts[reminder.thread_root_id] ?? 0) : 0,
          newCount: 1,
        });
      });

    return items;
  }, [allThreadRootMessages, channelAlertIds, data, threadReplyCounts, threadReplySummaries, threadUnreadCounts, visibleMessages]);

  const activityFeedItems = useMemo(() => {
    return allActivityFeedItems
      .filter((item) => {
        const dismissedAt = dismissedActivityFeedItems[item.dismissId];
        if (!dismissedAt) return true;
        return timestampMs(item.timestamp) > timestampMs(dismissedAt);
      })
      .map((item) => {
        const readAt = readActivityFeedItems[item.id];
        if (!readAt || timestampMs(item.timestamp) > timestampMs(readAt)) {
          return item;
        }
        return { ...item, unread: false };
      })
      .sort((left, right) => {
        if (left.unread !== right.unread) return left.unread ? -1 : 1;
        return timestampMs(right.timestamp) - timestampMs(left.timestamp);
      })
      .slice(0, 120);
  }, [allActivityFeedItems, dismissedActivityFeedItems, readActivityFeedItems]);

  const activityFeedUnreadCount = useMemo(() => {
    return activityFeedItems.filter((item) => item.unread).length;
  }, [activityFeedItems]);

  const savedMessageIds = useMemo(() => {
    return new Set(data?.saved_messages.map((item) => item.message_id) ?? []);
  }, [data?.saved_messages]);

  const todoMessageIds = useMemo(() => {
    return new Set(data?.todo_items.flatMap((item) => !item.done_at && item.message_id ? [item.message_id] : []) ?? []);
  }, [data?.todo_items]);

  const savedUnreadCount = useMemo(() => {
    const items = data?.saved_messages ?? [];
    if (items.length === 0) return 0;
    const readUntil = dismissedActivityFeedItems[SAVED_MESSAGES_READ_DISMISS_ID];
    if (!readUntil) return items.length;
    const readUntilTime = timestampMs(readUntil);
    if (!Number.isFinite(readUntilTime)) return items.length;
    return items.filter((item) => timestampMs(item.created_at) > readUntilTime).length;
  }, [data?.saved_messages, dismissedActivityFeedItems]);

  const shareBaseUrl = useMemo(() => {
    if (!data) return window.location.origin;
    return isTauriRuntime() ? data.web_base_url ?? window.location.origin : window.location.origin;
  }, [data?.web_base_url]);

  const visibleTasks = useMemo(() => {
    if (!data || !channel) return [];
    if (channel.kind === "dm") return [];
    return data.tasks.filter((task) => task.channel_id === channel.id);
  }, [data, channel]);

  const channelMemberIds = useMemo(() => {
    if (!data || !channel) return new Set<string>();
    return new Set(data.channel_members.filter((member) => member.channel_id === channel.id).map((member) => member.agent_id));
  }, [data, channel]);

  const channelAgents = useMemo(() => {
    if (!data || !channel) return [];
    return data.agents.filter((agent) => channelMemberIds.has(agent.id));
  }, [data, channel, channelMemberIds]);

  const activeTask = useMemo(() => {
    if (!data || !activeRoot) return null;
    return data.tasks.find((task) => task.message_id === activeRoot.id) ?? null;
  }, [data, activeRoot]);

  const activeChannelMessageCount = useMemo(() => {
    if (!activeChannelId) return 0;
    return visibleMessages.filter((message) => message.channel_id === activeChannelId).length;
  }, [visibleMessages, activeChannelId]);

  const activeRunFor = useCallback((agentId: string) => {
    return data?.agent_runs.find((run) => run.agent_id === agentId && ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
  }, [data?.agent_runs]);

  const selectedAgent = useMemo(() => {
    if (!data || !selectedAgentId) return null;
    return data.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  }, [data, selectedAgentId]);

  const selectedAgentRun = useMemo(() => {
    if (!selectedAgent) return null;
    return activeRunFor(selectedAgent.id);
  }, [selectedAgent, activeRunFor]);

  const selectedAgentActivities = useMemo(() => {
    if (!data || !selectedAgent) return [];
    return data.agent_activities
      .filter((activity) => activity.agent_id === selectedAgent.id || activity.agent_handle === selectedAgent.handle)
      .slice(0, 80);
  }, [data, selectedAgent]);

  const selectedAgentRuns = useMemo(() => {
    if (!data || !selectedAgent) return [];
    return data.agent_runs.filter((run) => run.agent_id === selectedAgent.id);
  }, [data, selectedAgent]);

  const selectedAgentPerformance = useMemo(() => {
    return buildAgentPerformance(selectedAgentActivities, selectedAgentRuns);
  }, [selectedAgentActivities, selectedAgentRuns]);

  const selectedAgentLiveActivity = useMemo(() => {
    return selectedAgentActivities.find((activity) => activity.run_id === selectedAgentRun?.id)
      ?? selectedAgentActivities.find((activity) => activity.kind in ACTIVITY_PHASE_LABELS)
      ?? null;
  }, [selectedAgentActivities, selectedAgentRun]);

  const selectedAgentPhase = selectedAgent ? (selectedAgentRun
    ? {
        kind: selectedAgentLiveActivity?.phase ?? selectedAgentLiveActivity?.kind ?? "run",
        label: selectedAgentLiveActivity ? phaseForActivity(selectedAgentLiveActivity.phase || selectedAgentLiveActivity.kind) : "Running",
        detail: selectedAgentLiveActivity?.summary || selectedAgentLiveActivity?.detail || "Waiting for observable output from the agent.",
      }
    : {
        kind: selectedAgent.status,
        label: selectedAgent.status,
        detail: "No active run.",
      }) : null;

  const selectedAgentWorkItems = useMemo(() => {
    if (!data || !selectedAgent) return [];
    return data.agent_work_items
      .filter((item) => item.agent_id === selectedAgent.id && item.status !== "silent")
      .sort((left, right) => {
        const leftQueuedTask = left.status === "queued" && left.task_id ? 0 : 1;
        const rightQueuedTask = right.status === "queued" && right.task_id ? 0 : 1;
        if (leftQueuedTask !== rightQueuedTask) return leftQueuedTask - rightQueuedTask;
        return timestampMs(right.created_at) - timestampMs(left.created_at);
      });
  }, [data, selectedAgent]);

  const searchResults = useMemo(() => {
    if (!data) return [];
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const channelById = new Map(data.channels.map((item) => [item.id, item]));
    const agentById = new Map(data.agents.map((item) => [item.id, item]));
    const channelLabel = (channelId: string | null) => {
      if (!channelId) return "No channel";
      const target = channelById.get(channelId);
      if (!target) return "Unknown channel";
      if (target.kind === "dm") {
        const agent = target.dm_agent_id ? agentById.get(target.dm_agent_id) : null;
        return agent ? `DM with @${agent.handle}` : "Direct message";
      }
      return `#${target.name}`;
    };
    const includes = (value: string) => value.toLowerCase().includes(query);
    const results: SearchResult[] = [];

    if (searchScopeAllows(searchScope, "channels")) {
      results.push(...data.channels
        .filter((item) => {
        const dmAgent = item.kind === "dm" ? data.agents.find((agent) => agent.id === item.dm_agent_id) : null;
          return includes(`${item.name} ${visibleChannelDescription(item.description)} ${dmAgent?.handle ?? ""} ${dmAgent?.display_name ?? ""}`);
        })
        .map((item) => {
        const dmAgent = item.kind === "dm" ? data.agents.find((agent) => agent.id === item.dm_agent_id) : null;
        return {
          id: item.id,
          kind: item.kind === "dm" ? "dm" : "channel",
          title: item.kind === "dm" ? `@${dmAgent?.handle ?? "agent"}` : `#${item.name}`,
          detail: item.kind === "dm" ? dmAgent?.display_name ?? "direct message" : visibleChannelDescription(item.description) || "channel",
          excerpt: item.kind === "dm" ? dmAgent?.description ?? "" : visibleChannelDescription(item.description),
          createdAt: null,
          channelId: item.id,
          threadId: null,
          agentId: dmAgent?.id ?? null,
        };
        }).slice(0, 10));
    }

    if (searchScopeAllows(searchScope, "tasks")) {
      results.push(...data.tasks
        .filter((item) =>
          matchesSearchTime(item.updated_at, searchTimeRange) &&
          includes(`${item.title} ${item.status} ${item.channel_name} ${item.assignee_name ?? ""}`))
        .map((item) => ({
        id: item.id,
        kind: "task",
        title: `#${item.number} ${item.title}`,
        detail: `${item.channel_name} · ${item.status.replace("_", " ")}`,
        excerpt: item.assignee_name ? `Assigned to ${item.assignee_name}` : "Unassigned",
        createdAt: item.updated_at,
        channelId: item.channel_id,
        threadId: item.message_id,
        agentId: null,
      })).slice(0, 12));
    }

    if (searchScopeAllows(searchScope, "messages")) {
      results.push(...visibleMessages
        .filter((item) =>
          matchesSearchTime(item.created_at, searchTimeRange) &&
          includes(`${displayNameForSender(item, data.owner_profile)} ${item.sender_name} ${item.body} ${channelLabel(item.channel_id)}`))
        .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
        .map((item) => ({
        id: item.id,
        kind: item.thread_root_id ? "reply" : "message",
        title: displayNameForSender(item, data.owner_profile),
        detail: `${channelLabel(item.channel_id)} · ${item.thread_root_id ? "thread reply" : "message"} · ${formatTime(item.created_at)}`,
        excerpt: firstLines(item.body, 2),
        createdAt: item.created_at,
        channelId: item.channel_id,
        threadId: item.thread_root_id ?? item.id,
        agentId: item.sender_agent_id,
        senderRole: item.sender_role,
      })).slice(0, 40));
    }

    if (searchScopeAllows(searchScope, "artifacts")) {
      results.push(...data.artifacts
        .filter((item) =>
          matchesSearchTime(item.created_at, searchTimeRange) &&
          includes(`${item.title} ${item.summary} ${item.content} ${item.kind} ${channelLabel(item.channel_id)}`))
        .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
        .map((item) => ({
        id: item.id,
        kind: "artifact",
        title: item.title,
        detail: `${item.kind} · ${channelLabel(item.channel_id)} · ${formatTime(item.created_at)}`,
        excerpt: firstLines(item.summary || item.content, 2),
        createdAt: item.created_at,
        channelId: item.channel_id,
        threadId: item.thread_root_id ?? item.message_id,
        agentId: item.creator_agent_id,
      })).slice(0, 20));
    }

    if (searchScopeAllows(searchScope, "agents")) {
      results.push(...data.agents
        .filter((item) => includes(`${item.handle} ${item.display_name} ${item.runtime} ${item.model} ${item.description}`))
        .map((item) => ({
        id: item.id,
        kind: "agent",
        title: `@${item.handle}`,
        detail: `${item.display_name} · ${item.runtime} · ${item.status}`,
        excerpt: item.description,
        createdAt: null,
        channelId: null,
        threadId: null,
        agentId: item.id,
      })).slice(0, 10));
    }

    if (searchScopeAllows(searchScope, "activity")) {
      results.push(...data.agent_activities
        .filter((item) =>
          matchesSearchTime(item.created_at, searchTimeRange) &&
          includes(`${item.agent_handle} ${item.kind} ${item.title} ${item.detail}`))
        .sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at))
        .map((item) => ({
        id: item.id,
        kind: "activity",
        title: item.title,
        detail: `${item.agent_handle || "unknown"} · ${formatTime(item.created_at)}`,
        excerpt: item.detail,
        createdAt: item.created_at,
        channelId: null,
        threadId: null,
        agentId: item.agent_id,
      })).slice(0, 16));

      results.push(...data.agent_work_items
        .filter((item) =>
          item.status !== "silent" &&
          matchesSearchTime(item.updated_at, searchTimeRange) &&
          includes(`${item.agent_handle} ${item.status} ${item.title} ${item.context}`))
        .sort((a, b) => timestampMs(b.updated_at) - timestampMs(a.updated_at))
        .map((item) => ({
        id: item.id,
        kind: "request",
        title: item.title,
        detail: `${agentRequestSourceLabel(item.source_kind, item.task_number)} · ${item.agent_handle} · ${item.status} · ${channelLabel(item.channel_id)}`,
        excerpt: firstLines(item.context, 2),
        createdAt: item.updated_at,
        channelId: item.channel_id,
        threadId: item.thread_root_id,
        agentId: item.agent_id,
      })).slice(0, 16));
    }

    return results.slice(0, 80);
  }, [data, searchQuery, searchScope, searchTimeRange, visibleMessages]);

  function taskForMessage(messageId: string) {
    return data?.tasks.find((task) => task.message_id === messageId) ?? null;
  }

  function normalizedChannelNameInput(value: string) {
    return value.trim().replace(/^#+/, "").toLowerCase().replace(/ /g, "-");
  }

  function channelNameExists(normalizedName: string, excludeChannelId?: string) {
    return Boolean(data?.channels.some((item) => (
      item.id !== excludeChannelId &&
      item.name === normalizedName
    )));
  }

  function duplicateChannelNameMessage(normalizedName: string) {
    return `Channel #${normalizedName} already exists`;
  }

  function isDuplicateChannelNameError(message: string) {
    const normalized = message.toLowerCase();
    return normalized.startsWith("channel #") && normalized.endsWith(" already exists");
  }

  const normalizedNewChannelName = normalizedChannelNameInput(newChannel);
  const newChannelDuplicateError = normalizedNewChannelName && channelNameExists(normalizedNewChannelName)
    ? duplicateChannelNameMessage(normalizedNewChannelName)
    : null;
  const newChannelNameError = newChannelDuplicateError || newChannelNameSubmitError;

  useEffect(() => {
    setChannelNameDraft(channel?.name ?? "");
    setChannelDescriptionDraft(channel ? visibleChannelDescription(channel.description) : "");
  }, [channel?.id, channel?.name, channel?.description]);

  useEffect(() => {
    if (channel?.kind !== "dm") return;
    setActiveTab("chat");
    setShowChannelSettingsModal(false);
    setShowChannelAgentsModal(false);
  }, [channel?.id, channel?.kind]);

  useEffect(() => {
    if (!activeChannelId) return;
    apiInvoke("mark_channel_read", { channelId: activeChannelId }).catch((err) => console.error(err));
  }, [activeChannelId, activeChannelMessageCount]);

  async function createChannel() {
    if (createChannelSubmittingRef.current) return;
    const name = normalizedChannelNameInput(newChannel);
    if (!name) return;
    if (channelNameExists(name)) {
      setNewChannelNameSubmitError(duplicateChannelNameMessage(name));
      return;
    }
    const agentIds = Array.from(newChannelAgentIds);
    let result: { channelId?: string } = {};
    const shouldReturnToMobileHome = createChannelOpenedFromMobileHomeRef.current;
    createChannelSubmittingRef.current = true;
    setCreateChannelSubmitting(true);
    try {
      result = await apiInvoke<{ channelId?: string }>("create_channel", {
        name,
        agentIds: agentIds.length > 0 ? agentIds : undefined,
      });
      await refresh({
        reason: "mutation:create_channel",
        source: "mutation",
        preferredActiveChannelId: shouldReturnToMobileHome ? undefined : result.channelId,
      });
    } catch (err) {
      const message = errorMessage(err, "create_channel failed");
      if (isDuplicateChannelNameError(message)) {
        setNewChannelNameSubmitError(duplicateChannelNameMessage(name));
        setAppError(null);
      } else {
        setAppError(message);
        console.error(err);
      }
      return;
    } finally {
      createChannelSubmittingRef.current = false;
      setCreateChannelSubmitting(false);
    }
    setNewChannel("");
    setNewChannelNameSubmitError(null);
    setNewChannelAgentIds(new Set());
    setShowCreateChannelModal(false);
    createChannelOpenedFromMobileHomeRef.current = false;
    if (shouldReturnToMobileHome) {
      returnToMobileHome();
      return;
    }
    if (result.channelId) {
      selectChannel(result.channelId);
    }
  }

  async function saveChannel() {
    if (!channel) return;
    const name = normalizedChannelNameInput(channelNameDraft);
    if (!name) return;
    if (channel.kind === "dm") {
      setAppError("Direct message settings are managed by the agent profile");
      setShowChannelSettingsModal(false);
      return;
    }
    if (channelNameExists(name, channel.id)) {
      setAppError(`Channel #${name} already exists`);
      return;
    }
    await mutate("update_channel", {
      channelId: channel.id,
      name,
      description: channelDescriptionDraft,
    });
    setShowChannelSettingsModal(false);
  }

  async function saveOwnerProfile() {
    if (!ownerProfileDraft.displayName.trim()) return;
    await mutate("update_owner_profile", {
      displayName: ownerProfileDraft.displayName,
      avatar: ownerProfileDraft.avatar,
      description: ownerProfileDraft.description,
    });
    setShowOwnerProfileModal(false);
  }

  async function deleteChannel() {
    if (!channel) return;
    const channelToDelete = channel;
    const fallbackChannelId = data?.channels.find((item) => item.id !== channelToDelete.id)?.id ?? "";
    setConfirmRequest({
      title: `Delete #${channelToDelete.name}?`,
      body: "This removes the channel timeline, tasks, threads, agent memberships, schedules, and attachments for this channel. This cannot be undone.",
      confirmLabel: "Delete channel",
      onConfirm: async () => {
        await mutate("delete_channel", { channelId: channelToDelete.id });
        setShowChannelSettingsModal(false);
        forgetChannelThread(channelToDelete.id);
        if (activeChannelId === channelToDelete.id) {
          setActiveChannelId(fallbackChannelId);
          openThread(rememberedThreadForChannel(fallbackChannelId), fallbackChannelId);
          if (isMobileViewport()) {
            returnToMobileHome();
          }
        }
      },
    });
  }

  function updateRootComposerDraft(channelId: string | null | undefined, updater: (draft: ComposerDraftState) => ComposerDraftState) {
    setRootComposerDrafts((current) => updateComposerDraftRecord(current, channelId, updater));
  }

  function updateReplyComposerDraft(threadId: string | null | undefined, updater: (draft: ComposerDraftState) => ComposerDraftState) {
    setReplyComposerDrafts((current) => updateComposerDraftRecord(current, threadId, updater));
  }

  function setDraft(value: string) {
    updateRootComposerDraft(activeChannelId, (current) => ({ ...current, text: value }));
  }

  function setReplyDraft(value: string) {
    updateReplyComposerDraft(activeThreadId, (current) => ({ ...current, text: value }));
  }

  function addRootAgentMentionBinding(agent: Agent) {
    updateRootComposerDraft(activeChannelId, (current) => ({
      ...current,
      mentionBindings: [...current.mentionBindings, agentMentionBinding(agent)],
    }));
  }

  function addReplyAgentMentionBinding(agent: Agent) {
    updateReplyComposerDraft(activeThreadId, (current) => ({
      ...current,
      mentionBindings: [...current.mentionBindings, agentMentionBinding(agent)],
    }));
  }

  function defaultThreadForChannel(channelId: string) {
    const repliedRootIds = new Set(
      visibleMessages
        .filter((message) => message.channel_id === channelId && message.thread_root_id)
        .map((message) => message.thread_root_id),
    );
    return visibleMessages.find((m) => m.channel_id === channelId && !m.thread_root_id && repliedRootIds.has(m.id))?.id ?? null;
  }

  function rootThreadBelongsToChannel(channelId: string, threadId: string) {
    return visibleMessages.some((message) => message.channel_id === channelId && !message.thread_root_id && message.id === threadId);
  }

  function rememberedThreadForChannel(channelId: string) {
    if (!Object.prototype.hasOwnProperty.call(channelThreadMemory, channelId)) {
      return defaultThreadForChannel(channelId);
    }
    const rememberedThreadId = channelThreadMemory[channelId];
    if (!rememberedThreadId) return null;
    return rootThreadBelongsToChannel(channelId, rememberedThreadId)
      ? rememberedThreadId
      : defaultThreadForChannel(channelId);
  }

  function rememberChannelThread(channelId: string | null | undefined, threadId: string | null) {
    if (!channelId) return;
    setChannelThreadMemory((current) => {
      if (current[channelId] === threadId) return current;
      return { ...current, [channelId]: threadId };
    });
  }

  function forgetChannelThread(channelId: string | null | undefined) {
    if (!channelId) return;
    setChannelThreadMemory((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, channelId)) return current;
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }

  function restoreRememberedThreadForChannel(channelId: string) {
    const nextThreadId = rememberedThreadForChannel(channelId);
    openThread(nextThreadId, channelId);
    if (!isMobileViewport()) {
      setShowThread(Boolean(nextThreadId));
    }
  }

  function selectChannel(channelId: string) {
    const nextChannel = data?.channels.find((item) => item.id === channelId) ?? null;
    setActiveMainView("channels");
    setSelectedAgentId(null);
    setActiveChannelId(channelId);
    setShowMobileSidebar(false);
    if (nextChannel?.kind === "dm") {
      setActiveTab("chat");
    }
    restoreRememberedThreadForChannel(channelId);
  }

  function openThread(threadId: string | null, channelId = activeChannelId) {
    clearSearchResultThreadProvenance(threadId);
    setActiveThreadId(threadId);
    rememberChannelThread(channelId, threadId);
    setFocusedMessageId(null);
    if (!threadId) return;
    const dismissedUntil = threadReadCutoff(threadId);
    setReadActivityFeedItems((current) => {
      const itemId = `thread:${threadId}`;
      const currentTime = current[itemId] ? timestampMs(current[itemId]) : 0;
      const nextTime = timestampMs(dismissedUntil);
      if (Number.isFinite(currentTime) && Number.isFinite(nextTime) && currentTime >= nextTime) return current;
      return { ...current, [itemId]: dismissedUntil };
    });
    persistThreadRead(threadId, dismissedUntil).catch((err) => console.error(err));
    setThreadUnreadCounts((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  function revealThread(threadId: string | null, channelId = activeChannelId) {
    openThread(threadId, channelId);
    if (threadId) {
      setSelectedAgentId(null);
      setShowThread(true);
    }
  }

  function canNavigateBack() {
    if (isMobileViewport()) return false;
    return appHistoryReadyRef.current && appHistoryIndexRef.current > 0;
  }

  function canNavigateForward() {
    if (isMobileViewport()) return false;
    return appHistoryReadyRef.current && appHistoryIndexRef.current < appHistoryMaxIndexRef.current;
  }

  function navigateBack(fallback: () => void) {
    if (isMobileViewport()) {
      fallback();
      return;
    }
    if (canNavigateBack()) {
      window.history.back();
      return;
    }
    fallback();
  }

  function navigateForward() {
    if (isMobileViewport()) return;
    if (canNavigateForward()) {
      window.history.forward();
    }
  }

  function openMobileSidebarFromContent() {
    setMobileSidebarFocus("home");
    if (isMobileViewport()) {
      setShowThread(false);
      setSelectedAgentId(null);
      setShowMobileSidebar(true);
      setMobileSidebarDragPx(0);
      return;
    }
    setShowMobileSidebar(true);
  }

  function openMobileHome() {
    returnToMobileHome();
  }

  function isMobileHomeOpen() {
    return isMobileViewport() && showMobileSidebar && mobileSidebarFocus === "home";
  }

  function returnToMobileHome() {
    setActiveMainView("channels");
    setShowSearchModal(false);
    setShowActivityFeedModal(false);
    setShowSavedModal(false);
    setSelectedAgentId(null);
    setShowThread(false);
    setShowMobileSidebar(true);
    setMobileSidebarDragPx(0);
    setMobileSidebarFocus("home");
  }

  function openSearchModal() {
    setShowMobileSidebar(false);
    setMobileSidebarFocus("home");
    setShowActivityFeedModal(false);
    setShowSavedModal(false);
    setShowSearchModal(true);
  }

  function openActivityFeedModal() {
    setShowMobileSidebar(false);
    setMobileSidebarFocus("home");
    setShowSearchModal(false);
    setShowSavedModal(false);
    setShowActivityFeedModal(true);
  }

  function openSavedModal() {
    setShowMobileSidebar(false);
    setMobileSidebarFocus("home");
    setShowSearchModal(false);
    setShowActivityFeedModal(false);
    setShowSavedModal(true);
    void markSavedMessagesRead();
  }

  function openVoiceConsole() {
    setActiveMainView("voice");
    setShowMobileSidebar(false);
    setMobileSidebarFocus("home");
    setMobileSidebarDragPx(0);
    setShowSearchModal(false);
    setShowActivityFeedModal(false);
    setShowSavedModal(false);
    setSelectedAgentId(null);
    setShowThread(false);
  }

  async function markSavedMessagesRead() {
    const items = data?.saved_messages ?? [];
    if (items.length === 0) return;
    const latestSavedAt = items.reduce((latest, item) => {
      const savedAt = timestampMs(item.created_at);
      return Number.isFinite(savedAt) ? Math.max(latest, savedAt) : latest;
    }, 0);
    const cutoff = new Date(Math.max(Date.now(), latestSavedAt)).toISOString();
    const current = dismissedActivityFeedItems[SAVED_MESSAGES_READ_DISMISS_ID];
    if (current && timestampMs(current) >= timestampMs(cutoff)) return;
    setDismissedActivityFeedItems((existing) => ({ ...existing, [SAVED_MESSAGES_READ_DISMISS_ID]: cutoff }));
    await apiInvoke("dismiss_inbox_items", {
      items: [{ itemId: SAVED_MESSAGES_READ_DISMISS_ID, dismissedUntil: cutoff }],
    });
  }

  function closeAppModal(fallback: () => void) {
    if (isMobileViewport()) {
      fallback();
      return;
    }
    if (activeMobileModal && canNavigateBack()) {
      window.history.back();
      return;
    }
    fallback();
  }

  function closeSelectedAgent() {
    if (selectedAgentId && searchResultAgentIdRef.current === selectedAgentId) {
      searchResultAgentIdRef.current = null;
      replaceNextAppHistoryEntryRef.current = true;
      setSelectedAgentId(null);
      return;
    }
    navigateBack(() => setSelectedAgentId(null));
  }

  function closeThreadPanel() {
    if (activeThreadId && searchResultThreadIdRef.current === activeThreadId) {
      searchResultThreadIdRef.current = null;
    }
    replaceNextAppHistoryEntryRef.current = true;
    openThread(null);
    setShowThread(false);
  }

  function optimisticMessageAttachments(messageId: string, attachments: DraftAttachment[]): MessageAttachment[] {
    const objectUrls: string[] = [];
    const messageAttachments = attachments.map((attachment) => {
      const localUrl = URL.createObjectURL(attachment.file);
      objectUrls.push(localUrl);
      return {
        id: `local-${attachment.id}`,
        message_id: messageId,
        original_name: attachment.original_name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        storage_path: "",
        local_url: localUrl,
        created_at: new Date().toISOString(),
      };
    });
    if (objectUrls.length > 0) {
      optimisticAttachmentUrlsRef.current.set(messageId, objectUrls);
    }
    return messageAttachments;
  }

  function releaseOptimisticAttachmentUrls(messageId: string) {
    const objectUrls = optimisticAttachmentUrlsRef.current.get(messageId) ?? [];
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    optimisticAttachmentUrlsRef.current.delete(messageId);
  }

  function addOptimisticOwnerMessage(
    channelId: string,
    threadRootId: string | null,
    body: string,
    asTask: boolean,
    attachments: DraftAttachment[] = [],
  ) {
    const id = `local-${clientId()}`;
    const createdAt = new Date().toISOString();
    const optimisticMessage: Message = {
      id,
      channel_id: channelId,
      thread_root_id: threadRootId,
      sender_agent_id: null,
      sender_name: data?.owner_profile.display_name || DEFAULT_OWNER_DISPLAY_NAME,
      sender_role: "owner",
      body,
      is_task: asTask,
      thread_followed: true,
      delivery_state: attachments.length > 0 ? "sending" : "complete",
      stream_key: "",
      task_number: null,
      task_status: null,
      attachments: optimisticMessageAttachments(id, attachments),
      artifacts: [],
      created_at: createdAt,
      updated_at: createdAt,
    };
    optimisticMessagesRef.current.set(id, optimisticMessage);
    knownMessageIdsRef.current?.add(id);
    setData((current) => current ? {
      ...current,
      messages: [...current.messages, optimisticMessage],
    } : current);
    return id;
  }

  function removeOptimisticMessage(messageId: string) {
    optimisticMessagesRef.current.delete(messageId);
    releaseOptimisticAttachmentUrls(messageId);
    knownMessageIdsRef.current?.delete(messageId);
    setData((current) => current ? {
      ...current,
      messages: current.messages.filter((message) => message.id !== messageId),
    } : current);
  }

  function replaceOptimisticMessage(optimisticId: string, message: Message) {
    optimisticMessagesRef.current.delete(optimisticId);
    releaseOptimisticAttachmentUrls(optimisticId);
    knownMessageIdsRef.current?.delete(optimisticId);
    knownMessageIdsRef.current?.add(message.id);
    setData((current) => current ? {
      ...current,
      messages: mergeMessages(
        current.messages.filter((candidate) => candidate.id !== optimisticId),
        [message],
      ),
    } : current);
  }

  function appendDraftAttachments(files: FileList | File[], target: "root" | "reply") {
    const nextAttachments = Array.from(files)
      .filter((file) => {
        if (file.size <= MAX_ATTACHMENT_BYTES) return true;
        setAppError(`${file.name} is larger than 25MB`);
        return false;
      })
      .map(draftAttachmentFromFile);
    if (nextAttachments.length === 0) return;
    if (target === "root") {
      updateRootComposerDraft(activeChannelId, (current) => ({
        ...current,
        attachments: [...current.attachments, ...nextAttachments],
      }));
    } else {
      updateReplyComposerDraft(activeThreadId, (current) => ({
        ...current,
        attachments: [...current.attachments, ...nextAttachments],
      }));
    }
  }

  async function setChannelMember(agentId: string, member: boolean) {
    if (!channel) return;
    if (channel.kind === "dm") {
      setAppError("Direct message membership is fixed");
      return;
    }
    await mutate("set_channel_agent_membership", {
      channelId: channel.id,
      agentId,
      member,
    });
  }

  async function createAgent() {
    const preferredHandle = agentDraft.handle.trim() || agentDraft.displayName.trim();
    if (!preferredHandle) return;
    const shouldReturnToCreateChannel = returnToCreateChannelAfterAgent;
    const shouldReturnToMobileHome = createAgentOpenedFromMobileHomeRef.current && !shouldReturnToCreateChannel;
    const handle = availableAgentHandle(preferredHandle, data?.agents ?? []);
    const displayName = agentDraft.displayName.trim() || handle;
    const nextForm = {
      ...agentDraft,
      handle,
      displayName,
      launchCommand: buildPresetCommand({ ...agentDraft, handle, displayName }),
      workingDirectory: agentDraft.workingDirectory.trim() || defaultAgentWorkspace(handle),
    };
    const agentId = await apiInvoke<string>("create_agent", {
      handle,
      displayName: nextForm.displayName,
      role: nextForm.role,
      runtime: nextForm.runtime,
      model: nextForm.model,
      reasoningEffort: nextForm.reasoningEffort,
      serviceTier: nextForm.serviceTier,
      avatar: nextForm.avatar,
      description: nextForm.description,
      launchCommand: nextForm.launchCommand,
      workingDirectory: nextForm.workingDirectory,
      dailyBudgetMicros: budgetMicrosFromForm(nextForm.dailyBudgetUsd),
    });
    if (channel && !shouldReturnToCreateChannel && !shouldReturnToMobileHome) {
      if (channel.kind !== "dm") {
        await apiInvoke("set_channel_agent_membership", {
          channelId: channel.id,
          agentId,
          member: true,
        });
      }
    }
    await refresh({ reason: "mutation:create_agent", source: "mutation" });
    setAgentDraft(newAgentDraft());
    setShowCreateAgentModal(false);
    setReturnToCreateChannelAfterAgent(false);
    createAgentOpenedFromMobileHomeRef.current = false;
    if (shouldReturnToCreateChannel) {
      setShowCreateChannelModal(true);
      return;
    }
    if (shouldReturnToMobileHome) {
      returnToMobileHome();
    }
  }

  function updateDraftRuntime(runtime: string) {
    const preset = RUNTIME_PRESETS[runtime];
    const currentPreset = RUNTIME_PRESETS[agentDraft.runtime];
    const shouldReplaceModel =
      !agentDraft.model.trim() ||
      !preset?.models.includes(agentDraft.model) ||
      (currentPreset && agentDraft.model === currentPreset.defaultModel);
    setAgentDraft({
      ...agentDraft,
      runtime,
      model: preset && shouldReplaceModel ? preset.defaultModel : agentDraft.model,
      reasoningEffort: runtime === "codex" ? agentDraft.reasoningEffort || "medium" : agentDraft.reasoningEffort,
      serviceTier: runtime === "codex" ? agentDraft.serviceTier : "",
    });
  }

  function updateEditRuntime(runtime: string) {
    const preset = RUNTIME_PRESETS[runtime];
    const currentPreset = RUNTIME_PRESETS[agentEdit.runtime];
    const shouldReplaceModel =
      !agentEdit.model.trim() ||
      !preset?.models.includes(agentEdit.model) ||
      (currentPreset && agentEdit.model === currentPreset.defaultModel);
    setAgentEdit({
      ...agentEdit,
      runtime,
      model: preset && shouldReplaceModel ? preset.defaultModel : agentEdit.model,
      reasoningEffort: runtime === "codex" ? agentEdit.reasoningEffort || "medium" : agentEdit.reasoningEffort,
      serviceTier: runtime === "codex" ? agentEdit.serviceTier : "",
    });
  }

  function startEditAgent(agent: Agent) {
    setEditingAgentId(agent.id);
    setAgentEdit({
      handle: agent.handle,
      displayName: agent.display_name,
      role: agent.role || "agent",
      avatar: agent.avatar || "",
      runtime: agent.runtime,
      model: agent.model,
      reasoningEffort: agent.reasoning_effort || "medium",
      serviceTier: agent.service_tier || "",
      description: agent.description,
      launchCommand: agent.launch_command,
      workingDirectory: agent.working_directory,
      dailyBudgetUsd: budgetUsdFromMicros(agent.daily_budget_micros),
    });
  }

  async function saveAgent() {
    if (!editingAgentId || !(agentEdit.handle.trim() || agentEdit.displayName.trim())) return;
    const handle = availableAgentHandle(
      agentEdit.handle.trim() || agentEdit.displayName.trim(),
      data?.agents ?? [],
      editingAgentId,
    );
    const displayName = agentEdit.displayName.trim() || handle;
    const nextForm = {
      ...agentEdit,
      handle,
      displayName,
      launchCommand: buildPresetCommand({ ...agentEdit, handle, displayName }),
      workingDirectory: agentEdit.workingDirectory.trim(),
    };
    await mutate("update_agent", {
      agentId: editingAgentId,
      handle: nextForm.handle,
      displayName: nextForm.displayName || nextForm.handle,
      role: nextForm.role,
      runtime: nextForm.runtime,
      model: nextForm.model,
      reasoningEffort: nextForm.reasoningEffort,
      serviceTier: nextForm.serviceTier,
      avatar: nextForm.avatar,
      description: nextForm.description,
      launchCommand: nextForm.launchCommand,
      workingDirectory: nextForm.workingDirectory,
      dailyBudgetMicros: budgetMicrosFromForm(nextForm.dailyBudgetUsd),
    });
    setEditingAgentId(null);
    setAgentEdit(EMPTY_AGENT_FORM);
  }

  function cancelEditAgent() {
    setEditingAgentId(null);
    setAgentEdit(EMPTY_AGENT_FORM);
  }

  async function deleteAgent(agent: Agent) {
    const agentDm = data?.channels.find((item) => item.kind === "dm" && item.dm_agent_id === agent.id) ?? null;
    const fallbackChannelId = data?.channels.find((item) => item.id !== agentDm?.id)?.id ?? null;
    setConfirmRequest({
      title: `Delete @${agent.handle}?`,
      body: "This removes the agent profile, DM, schedules, runtime sessions, runs, and pending requests. Existing channel messages keep their sender name.",
      confirmLabel: "Delete agent",
      onConfirm: async () => {
        await mutate("delete_agent", { agentId: agent.id });
        if (editingAgentId === agent.id) setEditingAgentId(null);
        if (selectedAgentId === agent.id) setSelectedAgentId(null);
        if (agentDm) forgetChannelThread(agentDm.id);
        if (agentDm && activeChannelId === agentDm.id) {
          setActiveChannelId(fallbackChannelId ?? "");
          openThread(rememberedThreadForChannel(fallbackChannelId ?? ""), fallbackChannelId ?? "");
        }
      },
    });
  }

  async function sendRootMessage(asTask = false) {
    if (!channel || (!draft.trim() && draftAttachments.length === 0)) return;
    const displayBody = draft.trim();
    const mentionBindings = rootComposerDraft.mentionBindings;
    const body = serializeAgentDisplayMentions(displayBody, data?.agents ?? [], mentionBindings);
    const attachments = draftAttachments;
    const sendAsTask = channel.kind === "dm" ? false : asTask;
    const optimisticId = addOptimisticOwnerMessage(channel.id, null, body, sendAsTask, attachments);
    updateRootComposerDraft(channel.id, () => EMPTY_COMPOSER_DRAFT);
    try {
      const message = await apiInvoke<Message>("send_message", {
        channelId: channel.id,
        threadRootId: null,
        body,
        asTask: sendAsTask,
        attachments: await attachmentUploads(attachments),
      });
      replaceOptimisticMessage(optimisticId, message);
    } catch (err) {
      removeOptimisticMessage(optimisticId);
      updateRootComposerDraft(channel.id, () => ({ text: displayBody, attachments, mentionBindings }));
      const message = errorMessage(err, "Failed to send message");
      setAppError(message);
      console.error(err);
    }
  }

  async function openDmWithAgent(agent: Agent) {
    try {
      const channelId = await apiInvoke<string>("open_dm_with_agent", { agentId: agent.id });
      await refresh({ reason: "mutation:open_dm_with_agent", source: "mutation" });
      setSelectedAgentId(null);
      setActiveChannelId(channelId);
      restoreRememberedThreadForChannel(channelId);
      setActiveTab("chat");
    } catch (err) {
      const message = errorMessage(err, "Failed to open direct message");
      setAppError(message);
      console.error(err);
    }
  }

  async function sendReply() {
    if (!channel || !activeRoot || (!replyDraft.trim() && replyAttachments.length === 0)) return;
    const displayBody = replyDraft.trim();
    const mentionBindings = replyComposerDraft.mentionBindings;
    const body = serializeAgentDisplayMentions(displayBody, data?.agents ?? [], mentionBindings);
    const attachments = replyAttachments;
    const optimisticId = addOptimisticOwnerMessage(channel.id, activeRoot.id, body, false, attachments);
    updateReplyComposerDraft(activeRoot.id, () => EMPTY_COMPOSER_DRAFT);
    try {
      const message = await apiInvoke<Message>("send_message", {
        channelId: channel.id,
        threadRootId: activeRoot.id,
        body,
        asTask: false,
        attachments: await attachmentUploads(attachments),
      });
      replaceOptimisticMessage(optimisticId, message);
    } catch (err) {
      removeOptimisticMessage(optimisticId);
      updateReplyComposerDraft(activeRoot.id, () => ({ text: displayBody, attachments, mentionBindings }));
      const message = errorMessage(err, "Failed to send reply");
      setAppError(message);
      console.error(err);
    }
  }

  async function updateTaskStatus(task: Task, status: string) {
    await mutate("update_task_status", { taskId: task.id, status });
  }

  async function saveTaskTitle(task: Task) {
    const title = (taskTitleDrafts[task.id] ?? task.title).trim();
    if (!title || title === task.title) return;
    await mutate("update_task_title", { taskId: task.id, title });
    setTaskTitleDrafts((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
  }

  function setTaskTitleDraft(task: Task, title: string) {
    setTaskTitleDrafts((current) => ({ ...current, [task.id]: title }));
  }

  async function claimTask(task: Task, agentId: string) {
    if (task.status === "done") return;
    if (task.assignee_id && agentId && task.assignee_id !== agentId) {
      await mutate("forward_task", {
        taskId: task.id,
        targetAgentId: agentId,
        interruptCurrent: false,
        reason: "manual_forward",
      });
      return;
    }
    await mutate("claim_task", { taskId: task.id, agentId: agentId || null });
  }

  function openTask(task: Task) {
    setActiveChannelId(task.channel_id);
    revealThread(task.message_id, task.channel_id);
    setActiveTab("chat");
  }

  function normalizedLocalLinkRef(value: string) {
    return value.trim().replace(/^[@#]/, "").toLowerCase();
  }

  function resolveChannelRef(channelRef: string) {
    const ref = normalizedLocalLinkRef(channelRef);
    return data?.channels.find((item) => (
      item.id.toLowerCase() === ref ||
      item.id.toLowerCase().startsWith(ref) ||
      item.name.toLowerCase() === ref ||
      item.name.toLowerCase().startsWith(ref)
    )) ?? null;
  }

  function resolveMessageRef(messageRef: string, channelId?: string | null) {
    const ref = messageRef.trim().toLowerCase();
    const candidates = data?.messages.filter((item) => !channelId || item.channel_id === channelId) ?? [];
    return candidates.find((item) => item.id.toLowerCase() === ref)
      ?? candidates.find((item) => item.id.toLowerCase().startsWith(ref))
      ?? null;
  }

  function revealMessage(message: Message) {
    selectChannel(message.channel_id);
    revealThread(message.thread_root_id ?? message.id, message.channel_id);
    setFocusedMessageId(message.id);
    setSelectedAgentId(null);
    setActiveTab("chat");
  }

  function openChannelTimeline(channelId: string) {
    setActiveChannelId(channelId);
    setActiveThreadId(null);
    rememberChannelThread(channelId, null);
    setFocusedMessageId(null);
    setSelectedAgentId(null);
    setShowThread(false);
    setShowMobileSidebar(false);
    setActiveTab("chat");
  }

  function openLocalLink(target: LocalEntityLinkTarget) {
    if (!data) return;
    if (target.type === "agent") {
      const agent = data.agents.find((candidate) => candidate.handle.toLowerCase() === normalizedLocalLinkRef(target.handle));
      if (agent) {
        openAgentDetail(agent.id);
      } else {
        setAppError(`Agent @${target.handle} was not found`);
      }
      return;
    }
    if (target.type === "task") {
      const task = data.tasks.find((item) => item.number === target.taskNumber);
      if (task) openTask(task);
      else setAppError(`Task #${target.taskNumber} was not found`);
      return;
    }
    if (target.type === "message") {
      const message = resolveMessageRef(target.messageRef);
      if (message) revealMessage(message);
      else setAppError(`Message ${target.messageRef} was not found`);
      return;
    }
    const targetChannel = resolveChannelRef(target.channelRef);
    if (!targetChannel) {
      if (target.threadRef) {
        const message = resolveMessageRef(target.threadRef);
        if (message) {
          revealMessage(message);
          return;
        }
      }
      setAppError(`#${target.channelRef} was not found`);
      return;
    }
    if (!target.threadRef) {
      openChannelTimeline(targetChannel.id);
      return;
    }
    const threadMessage = resolveMessageRef(target.threadRef, targetChannel.id);
    if (!threadMessage) {
      setAppError(`Thread ${target.threadRef} was not found in #${targetChannel.name}`);
      return;
    }
    revealMessage(threadMessage);
  }

  function openWorkItem(item: AgentWorkItem, focusedMessageIdOverride?: string | null) {
    if (item.channel_id) setActiveChannelId(item.channel_id);
    if (item.thread_root_id) {
      revealThread(item.thread_root_id, item.channel_id ?? activeChannelId);
      setActiveTab("chat");
    }
    const agent = data?.agents.find((candidate) => candidate.id === item.agent_id);
    if (agent) openAgentDetail(agent.id);
    const focusId = focusedMessageIdOverride === undefined
      ? item.source_message_id
      : focusedMessageIdOverride;
    if (focusId) {
      const messageExists = Boolean(data?.messages.some((message) => message.id === focusId));
      if (messageExists) {
        setFocusedMessageId(focusId);
      } else if (item.channel_id) {
        setAppError("Original message no longer exists");
      }
    }
  }

  function openSearchResult(result: SearchResult) {
    const openedFromSearch = showSearchModal;
    let openedAgentId: string | null = null;
    if (result.agentId) {
      const agent = data?.agents.find((item) => item.id === result.agentId);
      if (agent) {
        openedAgentId = agent.id;
        setSelectedAgentId(agent.id);
      }
    }
    if (result.channelId) selectChannel(result.channelId);
    if (result.threadId) {
      revealThread(result.threadId, result.channelId ?? activeChannelId);
      setActiveTab("chat");
    }
    if (openedFromSearch) {
      replaceNextAppHistoryEntryRef.current = true;
      searchResultThreadIdRef.current = result.threadId ?? null;
      searchResultAgentIdRef.current = result.threadId ? null : openedAgentId;
    }
    setShowSearchModal(false);
  }

  function openSavedMessage(item: SavedMessage) {
    void markSavedMessagesRead();
    selectChannel(item.channel_id);
    revealThread(item.thread_root_id ?? item.message_id, item.channel_id);
    setFocusedMessageId(item.message_id);
    setActiveTab("chat");
    setShowSavedModal(false);
  }

  function openTodoItem(item: TodoItem) {
    if (!item.channel_id || !item.message_id) return;
    selectChannel(item.channel_id);
    revealThread(item.thread_root_id ?? item.message_id, item.channel_id);
    setFocusedMessageId(item.message_id);
    setActiveTab("chat");
    setShowSavedModal(false);
  }

  async function persistReadActivityFeedItems(items: ActivityFeedItem[], readUntil?: string | ((item: ActivityFeedItem) => string)) {
    const reads = items.map((item) => ({
      itemId: item.id,
      dismissedUntil: typeof readUntil === "function" ? readUntil(item) : (readUntil ?? activityFeedItemCutoff(item)),
    }));
    if (reads.length === 0) return;
    await apiInvoke("mark_inbox_items_read", { items: reads });
  }

  async function persistDismissedActivityFeedItems(
    items: ActivityFeedItem[],
    dismissedUntil?: string | ((item: ActivityFeedItem) => string),
  ) {
    const dismissals = items.map((item) => ({
      itemId: item.dismissId,
      dismissedUntil: typeof dismissedUntil === "function" ? dismissedUntil(item) : (dismissedUntil ?? activityFeedItemCutoff(item)),
    }));
    if (dismissals.length === 0) return;
    await apiInvoke("dismiss_inbox_items", { items: dismissals });
  }

  function activityFeedItemCutoff(item: ActivityFeedItem) {
    const itemTime = timestampMs(item.timestamp);
    const cutoffTime = Math.max(Date.now(), Number.isFinite(itemTime) ? itemTime : 0);
    return new Date(cutoffTime).toISOString();
  }

  function threadReadCutoff(threadId: string) {
    const latestAt = threadReplySummaries[threadId]?.latest?.created_at
      ?? threadActivityByRoot.get(threadId)?.latest_visible_at;
    const latestTime = latestAt ? timestampMs(latestAt) : 0;
    const cutoffTime = Math.max(Date.now(), Number.isFinite(latestTime) ? latestTime : 0);
    return new Date(cutoffTime).toISOString();
  }

  function isThreadActivityLocallyRead(activity: ThreadActivity) {
    const readUntil = readActivityFeedItems[`thread:${activity.thread_root_id}`];
    if (!readUntil || !activity.latest_visible_at) return false;
    const readUntilTime = timestampMs(readUntil);
    const latestVisibleTime = timestampMs(activity.latest_visible_at);
    return Number.isFinite(readUntilTime) &&
      Number.isFinite(latestVisibleTime) &&
      readUntilTime >= latestVisibleTime;
  }

  function mergeInboxReadItems(current: Record<string, string>, incoming: Record<string, string>) {
    let next: Record<string, string> | null = null;
    for (const [itemId, readUntil] of Object.entries(incoming)) {
      const currentReadUntil = current[itemId];
      const currentTime = currentReadUntil ? timestampMs(currentReadUntil) : NaN;
      const incomingTime = timestampMs(readUntil);
      if (currentReadUntil && Number.isFinite(currentTime) && (!Number.isFinite(incomingTime) || currentTime >= incomingTime)) {
        continue;
      }
      next ??= { ...current };
      next[itemId] = readUntil;
    }
    return next ?? current;
  }

  async function persistThreadRead(threadId: string, dismissedUntil = threadReadCutoff(threadId)) {
    await apiInvoke("mark_inbox_items_read", {
      items: [{
        itemId: `thread:${threadId}`,
        dismissedUntil,
      }],
    });
  }

  async function persistThreadReads(items: ActivityFeedItem[], cutoffByItemId: Map<string, string>) {
    const cutoffByThreadId = new Map<string, string>();
    for (const item of items) {
      if (!item.threadId) continue;
      const dismissedUntil = cutoffByItemId.get(item.id) ?? item.timestamp;
      const existing = cutoffByThreadId.get(item.threadId);
      if (!existing || timestampMs(dismissedUntil) > timestampMs(existing)) {
        cutoffByThreadId.set(item.threadId, dismissedUntil);
      }
    }
    const reads = Array.from(cutoffByThreadId, ([threadId, dismissedUntil]) => ({
      itemId: `thread:${threadId}`,
      dismissedUntil,
    }));
    if (reads.length === 0) return;
    await apiInvoke("mark_inbox_items_read", { items: reads });
  }

  function openActivityFeedItem(item: ActivityFeedItem) {
    if (item.unread) {
      void markActivityFeedItemRead(item);
    }
    const targetThreadId = item.threadId ?? item.messageId;
    if (item.channelId) selectChannel(item.channelId);
    setSelectedAgentId(null);
    setActiveTab("chat");
    if (targetThreadId) {
      revealThread(targetThreadId, item.channelId ?? activeChannelId);
    } else {
      openThread(null, item.channelId ?? activeChannelId);
      setShowThread(false);
    }
    if (item.messageId) {
      setFocusedMessageId(item.messageId);
    }
    setShowActivityFeedModal(false);
  }

  async function markActivityFeedItemRead(item: ActivityFeedItem) {
    if (!item.unread) return;
    const dismissedUntil = activityFeedItemCutoff(item);
    setReadActivityFeedItems((current) => ({ ...current, [item.id]: dismissedUntil }));
    const operations: Promise<unknown>[] = [persistReadActivityFeedItems([item], dismissedUntil)];
    if (item.threadId) {
      setThreadUnreadCounts((current) => {
        if (!current[item.threadId!]) return current;
        const next = { ...current };
        delete next[item.threadId!];
        return next;
      });
      operations.push(persistThreadRead(item.threadId, dismissedUntil));
    }
    if (item.channelId) {
      setChannelAlertIds((current) => {
        if (!current.has(item.channelId!)) return current;
        const next = new Set(current);
        next.delete(item.channelId!);
        return next;
      });
      operations.push(apiInvoke("mark_channel_read", { channelId: item.channelId }));
    }
    await Promise.all(operations);
    await refresh({ reason: "mutation:activity_feed_item_read", source: "mutation" });
  }

  async function dismissActivityFeedItem(item: ActivityFeedItem) {
    const dismissedUntil = activityFeedItemCutoff(item);
    setDismissedActivityFeedItems((current) => ({ ...current, [item.dismissId]: dismissedUntil }));
    await persistDismissedActivityFeedItems([item], dismissedUntil);
    await refresh({ reason: "mutation:activity_feed_item_dismiss", source: "mutation" });
  }

  async function dismissActivityFeedItems(items: ActivityFeedItem[]) {
    if (items.length === 0) return;
    const cutoffByDismissId = new Map<string, string>();
    for (const item of items) {
      const cutoff = activityFeedItemCutoff(item);
      const existing = cutoffByDismissId.get(item.dismissId);
      if (!existing || timestampMs(cutoff) > timestampMs(existing)) {
        cutoffByDismissId.set(item.dismissId, cutoff);
      }
    }
    setDismissedActivityFeedItems((current) => {
      const next = { ...current };
      for (const [dismissId, dismissedUntil] of cutoffByDismissId) {
        next[dismissId] = dismissedUntil;
      }
      return next;
    });
    await persistDismissedActivityFeedItems(items, (item) => cutoffByDismissId.get(item.dismissId) ?? item.timestamp);
    await refresh({ reason: "mutation:activity_feed_items_dismiss", source: "mutation" });
  }

  async function markAllActivityFeedRead(items: ActivityFeedItem[]) {
    const markReadItems = items.filter((item) => item.unread);
    if (markReadItems.length === 0) return;
    const cutoffByItemId = new Map(markReadItems.map((item) => [item.id, activityFeedItemCutoff(item)]));
    setReadActivityFeedItems((current) => {
      const next = { ...current };
      for (const item of markReadItems) {
        next[item.id] = cutoffByItemId.get(item.id) ?? item.timestamp;
      }
      return next;
    });
    setChannelAlertIds((current) => {
      const channelIds = new Set(markReadItems.map((item) => item.channelId).filter((id): id is string => Boolean(id)));
      if (channelIds.size === 0) return current;
      const next = new Set(current);
      for (const channelId of channelIds) {
        next.delete(channelId);
      }
      return next;
    });
    setThreadUnreadCounts((current) => {
      const threadIds = new Set(markReadItems.map((item) => item.threadId).filter((id): id is string => Boolean(id)));
      if (threadIds.size === 0) return current;
      const next = { ...current };
      for (const threadId of threadIds) {
        delete next[threadId];
      }
      return next;
    });
    await Promise.all([
      persistReadActivityFeedItems(markReadItems, (item) => cutoffByItemId.get(item.id) ?? item.timestamp),
      persistThreadReads(markReadItems, cutoffByItemId),
      ...Array.from(
        new Set(markReadItems.map((item) => item.channelId).filter((id): id is string => Boolean(id))),
        (channelId) => apiInvoke("mark_channel_read", { channelId }),
      ),
    ]);
    await refresh({ reason: "mutation:activity_feed_mark_all_read", source: "mutation" });
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    function onPointerMove(moveEvent: PointerEvent) {
      const delta = moveEvent.clientX - startX;
      const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - MIN_CONVERSATION_WIDTH - MIN_THREAD_PANEL_WIDTH);
      const next = Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta));
      setSidebarWidth(next);
    }

    function onPointerUp() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-column");
    }

    document.body.classList.add("resizing-column");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startThreadResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = threadPanelWidth;

    function onPointerMove(moveEvent: PointerEvent) {
      const delta = startX - moveEvent.clientX;
      const maxWidth = maxThreadPanelWidth(sidebarWidth);
      const next = Math.min(maxWidth, Math.max(MIN_THREAD_PANEL_WIDTH, startWidth + delta));
      setThreadPanelWidth(next);
    }

    function onPointerUp() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-column");
    }

    document.body.classList.add("resizing-column");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startAgentDrawerResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = agentDrawerWidth;

    function onPointerMove(moveEvent: PointerEvent) {
      const delta = startX - moveEvent.clientX;
      const maxWidth = maxAgentDrawerWidth(sidebarWidth);
      const next = Math.min(maxWidth, Math.max(MIN_AGENT_DRAWER_WIDTH, startWidth + delta));
      setAgentDrawerWidth(next);
    }

    function onPointerUp() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-column");
    }

    document.body.classList.add("resizing-column");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function startToolBrowserResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = toolBrowserPanelWidth;
    const startHeight = toolBrowserPanelHeight;
    let nextWidth = startWidth;
    let nextHeight = startHeight;
    let resizeFrame: number | null = null;

    function applyPendingSize() {
      resizeFrame = null;
      appShellRef.current?.style.setProperty("--tool-browser-width", `${nextWidth}px`);
      appShellRef.current?.style.setProperty("--tool-browser-height", `${nextHeight}px`);
      appShellRef.current?.style.setProperty("--tool-browser-page-scale", `${nextWidth / TOOL_BROWSER_PAGE_VIEWPORT_WIDTH}`);
      appShellRef.current?.style.setProperty("--tool-browser-mobile-floor-height", `${toolBrowserMobileFloorHeight(nextWidth, nextHeight)}px`);
      appShellRef.current?.style.setProperty("--tool-browser-mobile-floor-scale", `${toolBrowserMobileFloorScale(nextWidth)}`);
    }

    function onPointerMove(moveEvent: PointerEvent) {
      const widthDelta = startX - moveEvent.clientX;
      const heightDelta = moveEvent.clientY - startY;
      const widthFromX = startWidth + widthDelta;
      const frameHeightFromY = Math.max(0, startHeight + heightDelta - TOOL_BROWSER_PANEL_HEADER_HEIGHT);
      const widthFromY = frameHeightFromY * TOOL_BROWSER_PAGE_ASPECT_RATIO;
      const targetWidth = Math.abs(widthDelta) >= Math.abs(heightDelta * TOOL_BROWSER_PAGE_ASPECT_RATIO)
        ? widthFromX
        : widthFromY;
      nextWidth = Math.round(clampToolBrowserPanelWidth(targetWidth, sidebarWidth));
      nextHeight = toolBrowserPanelHeightForWidth(nextWidth);
      if (resizeFrame === null) {
        resizeFrame = window.requestAnimationFrame(applyPendingSize);
      }
    }

    function finishResize() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("blur", finishResize);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      appShellRef.current?.style.setProperty("--tool-browser-width", `${nextWidth}px`);
      appShellRef.current?.style.setProperty("--tool-browser-height", `${nextHeight}px`);
      appShellRef.current?.style.setProperty("--tool-browser-page-scale", `${nextWidth / TOOL_BROWSER_PAGE_VIEWPORT_WIDTH}`);
      appShellRef.current?.style.setProperty("--tool-browser-mobile-floor-height", `${toolBrowserMobileFloorHeight(nextWidth, nextHeight)}px`);
      appShellRef.current?.style.setProperty("--tool-browser-mobile-floor-scale", `${toolBrowserMobileFloorScale(nextWidth)}`);
      setToolBrowserPanelWidth(nextWidth);
      setToolBrowserPanelHeight(nextHeight);
      document.body.classList.remove("resizing-tool-browser");
    }

    document.body.classList.add("resizing-tool-browser");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("blur", finishResize);
  }

  function closeToolBrowserPanel() {
    setToolBrowserTarget(null);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  function toggleToolBrowserPanel() {
    setToolBrowserTarget((current) => current ? null : storedToolBrowserTarget());
  }

  async function cancelWorkItem(item: AgentWorkItem) {
    await mutate("cancel_agent_work", { workItemId: item.id });
  }

  async function retryWorkItem(item: AgentWorkItem) {
    await mutate("retry_agent_work", { workItemId: item.id });
  }

  async function forwardWorkItem(item: AgentWorkItem, targetAgentId: string) {
    if (item.status !== "queued") return;
    await mutate("reassign_agent_work", {
      workItemId: item.id,
      targetAgentId,
      reason: "manual_reassign",
    });
  }

  async function setMessageSaved(message: Message, saved: boolean) {
    await mutate("set_message_saved", { messageId: message.id, saved });
  }

  async function setMessageTodo(message: Message, todo: boolean) {
    const now = new Date().toISOString();
    const channelName = data?.channels.find((item) => item.id === message.channel_id)?.name ?? "";
    const summary = message.body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, 160) || "Empty message";
    setData((current) => {
      if (!current) return current;
      if (!todo) {
        return {
          ...current,
          todo_items: current.todo_items.filter((item) => item.message_id !== message.id),
        };
      }
      if (current.todo_items.some((item) => item.message_id === message.id && !item.done_at)) return current;
      return {
        ...current,
        todo_items: [
          {
            id: `optimistic-${message.id}`,
            message_id: message.id,
            channel_id: message.channel_id,
            channel_name: channelName,
            thread_root_id: message.thread_root_id,
            summary,
            sender_name: message.sender_name,
            sender_role: message.sender_role,
            message_created_at: message.created_at,
            created_at: now,
            done_at: null,
          },
          ...current.todo_items.filter((item) => item.message_id !== message.id),
        ],
      };
    });
    try {
      await apiInvoke("set_message_todo", { messageId: message.id, todo });
    } catch (err) {
      await refresh({ reason: "rollback:set_message_todo", source: "error_recovery" });
      const message = errorMessage(err, "set_message_todo failed");
      setAppError(message);
      console.error(err);
      throw err;
    }
  }

  async function unsaveSavedMessage(item: SavedMessage) {
    await mutate("set_message_saved", { messageId: item.message_id, saved: false });
  }

  async function completeTodoItem(item: TodoItem, done: boolean) {
    const doneAt = done ? new Date().toISOString() : null;
    setData((current) => current
      ? {
          ...current,
          todo_items: current.todo_items.map((candidate) => candidate.id === item.id
            ? { ...candidate, done_at: doneAt }
            : candidate),
        }
      : current);
    try {
      await apiInvoke("complete_todo_item", { todoId: item.id, done });
    } catch (err) {
      await refresh({ reason: "rollback:complete_todo_item", source: "error_recovery" });
      const message = errorMessage(err, "complete_todo_item failed");
      setAppError(message);
      console.error(err);
      throw err;
    }
  }

  async function createManualTodo(summary: string) {
    const now = new Date().toISOString();
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    const nextItem: TodoItem = {
      id: optimisticId,
      message_id: null,
      channel_id: null,
      channel_name: null,
      thread_root_id: null,
      summary,
      sender_name: null,
      sender_role: null,
      message_created_at: null,
      created_at: now,
      done_at: null,
    };
    setData((current) => current
      ? { ...current, todo_items: [nextItem, ...current.todo_items] }
      : current);
    try {
      const id = await apiInvoke<string>("create_todo_item", { summary });
      setData((current) => current
        ? {
            ...current,
            todo_items: current.todo_items.map((candidate) => candidate.id === optimisticId
              ? { ...candidate, id }
              : candidate),
          }
        : current);
    } catch (err) {
      setData((current) => current
        ? { ...current, todo_items: current.todo_items.filter((candidate) => candidate.id !== optimisticId) }
        : current);
      const message = errorMessage(err, "create_todo_item failed");
      setAppError(message);
      console.error(err);
      throw err;
    }
  }

  async function deleteTodoItem(item: TodoItem) {
    setData((current) => current
      ? { ...current, todo_items: current.todo_items.filter((candidate) => candidate.id !== item.id) }
      : current);
    try {
      await apiInvoke("delete_todo_item", { todoId: item.id });
    } catch (err) {
      await refresh({ reason: "rollback:delete_todo_item", source: "error_recovery" });
      const message = errorMessage(err, "delete_todo_item failed");
      setAppError(message);
      console.error(err);
      throw err;
    }
  }

  async function installSupervisorService() {
    await mutate("install_supervisor_service");
  }

  async function uninstallSupervisorService() {
    await mutate("uninstall_supervisor_service");
  }

  if (!data) {
    return (
      <div className="boot">
        <div className="boot-panel">
          <strong>Opening {APP_DISPLAY_NAME}...</strong>
          {appError ? (
            <>
              <p>{appError}</p>
              <button
                type="button"
                onClick={() => refreshWithError(normalizeRefreshRequest({
                  reason: "retry_initial_load",
                  source: "manual",
                  fallback: `Failed to load ${APP_DISPLAY_NAME} state`,
                }))}
              >
                Retry
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <main
      ref={appShellRef}
      className={`app theme-liquid notranslate ${(activeMainView === "channels" && (selectedAgent || showThread)) || (activeMainView === "voice" && activeVoiceThreadId) ? "" : "thread-hidden"} ${(activeMainView === "channels" && (selectedAgent || activeThreadId)) || (activeMainView === "voice" && activeVoiceThreadId) ? "right-panel-active" : ""} ${toolBrowserTarget ? "tool-browser-active" : ""} ${showMobileSidebar ? "mobile-sidebar-open" : ""} ${mobileDragSurface === "sidebar" ? "mobile-sidebar-dragging" : ""} ${mobileDragSurface === "panel" ? "mobile-panel-dragging" : ""} ${mobileComposerFocused ? "mobile-composer-focused" : ""}`}
      translate="no"
      style={{
        "--sidebar-width": `${sidebarWidth}px`,
        "--thread-width": `${selectedAgent ? agentDrawerWidth : threadPanelWidth}px`,
        "--tool-browser-width": `${toolBrowserPanelWidth}px`,
        "--tool-browser-height": `${toolBrowserPanelHeight}px`,
        "--tool-browser-page-width": `${TOOL_BROWSER_PAGE_VIEWPORT_WIDTH}px`,
        "--tool-browser-page-height": `${TOOL_BROWSER_PAGE_VIEWPORT_HEIGHT}px`,
        "--tool-browser-page-scale": `${toolBrowserPanelWidth / TOOL_BROWSER_PAGE_VIEWPORT_WIDTH}`,
        "--tool-browser-mobile-floor-width": `${TOOL_BROWSER_MOBILE_FLOOR_WIDTH}px`,
        "--tool-browser-mobile-floor-height": `${toolBrowserMobileFloorHeight(toolBrowserPanelWidth, toolBrowserPanelHeight)}px`,
        "--tool-browser-mobile-floor-scale": `${toolBrowserMobileFloorScale(toolBrowserPanelWidth)}`,
        "--mobile-sidebar-drag": `${mobileSidebarDragPx}px`,
        ...CHAT_TEXT_SIZE_STYLES[chatTextSize],
      } as CSSProperties}
    >
      <Sidebar
        data={data}
        channel={channel}
        channelAlertIds={channelAlertIds}
        activityFeedUnreadCount={activityFeedUnreadCount}
        savedUnreadCount={savedUnreadCount}
        voiceActive={activeMainView === "voice"}
        openSearch={openSearchModal}
        openActivityFeed={openActivityFeedModal}
        openSaved={openSavedModal}
        openVoice={openVoiceConsole}
        openDiagnosticsModal={() => {
          if (!isMobileHomeOpen()) {
            setShowMobileSidebar(false);
          }
          setShowDiagnosticsModal(true);
        }}
        openSettingsModal={() => {
          if (!isMobileHomeOpen()) {
            setShowMobileSidebar(false);
          }
          setShowSettingsModal(true);
        }}
        mobileFocus={mobileSidebarFocus}
        openCreateChannelModal={() => {
          const openedFromMobileHome = isMobileHomeOpen();
          createChannelOpenedFromMobileHomeRef.current = openedFromMobileHome;
          if (!openedFromMobileHome) {
            setShowMobileSidebar(false);
          }
          setReturnToCreateChannelAfterAgent(false);
          setNewChannelNameSubmitError(null);
          setShowCreateChannelModal(true);
        }}
        selectChannel={(channelId) => {
          setShowMobileSidebar(false);
          setMobileSidebarFocus("home");
          setMobileSidebarDragPx(0);
          selectChannel(channelId);
        }}
        openCreateAgentModal={() => {
          const openedFromMobileHome = isMobileHomeOpen();
          setAgentDraft(newAgentDraft());
          setReturnToCreateChannelAfterAgent(false);
          createAgentOpenedFromMobileHomeRef.current = openedFromMobileHome;
          if (!openedFromMobileHome) {
            setShowMobileSidebar(false);
          }
          setShowCreateAgentModal(true);
        }}
        openDmWithAgent={(agent) => {
          setShowMobileSidebar(false);
          openDmWithAgent(agent);
        }}
        openAgentDetail={(agent) => {
          setShowMobileSidebar(false);
          setMobileSidebarDragPx(0);
          openAgentDetail(agent.id);
        }}
        openOwnerProfileModal={() => {
          setOwnerProfileDraft(ownerProfileToForm(data.owner_profile));
          if (!isMobileHomeOpen()) {
            setShowMobileSidebar(false);
          }
          setShowOwnerProfileModal(true);
        }}
        onResizeStart={startSidebarResize}
      />
      <SearchModal
        open={showSearchModal}
        query={searchQuery}
        scope={searchScope}
        timeRange={searchTimeRange}
        results={searchResults}
        agents={data.agents}
        ownerProfile={data.owner_profile}
        onQueryChange={setSearchQuery}
        onScopeChange={setSearchScope}
        onTimeRangeChange={setSearchTimeRange}
        onOpenResult={openSearchResult}
        onClear={() => setSearchQuery("")}
        onClose={() => closeAppModal(() => setShowSearchModal(false))}
      />

      <ActivityFeedModal
        open={showActivityFeedModal}
        items={activityFeedItems}
        agents={data.agents}
        ownerProfile={data.owner_profile}
        onOpenItem={openActivityFeedItem}
        onMarkItemRead={markActivityFeedItemRead}
        onDismissItem={dismissActivityFeedItem}
        onDismissItems={dismissActivityFeedItems}
        onMarkAllRead={markAllActivityFeedRead}
        onClose={() => closeAppModal(() => setShowActivityFeedModal(false))}
      />

      <SavedMessagesModal
        open={showSavedModal}
        items={data.saved_messages}
        todoItems={data.todo_items}
        agents={data.agents}
        ownerProfile={data.owner_profile}
        onOpenItem={openSavedMessage}
        onOpenTodoItem={openTodoItem}
        onUnsaveItem={unsaveSavedMessage}
        onToggleTodoDone={completeTodoItem}
        onDeleteTodo={deleteTodoItem}
        onCreateTodo={createManualTodo}
        onClose={() => closeAppModal(() => setShowSavedModal(false))}
      />

      <OwnerProfileModal
        open={showOwnerProfileModal}
        form={ownerProfileDraft}
        onChange={setOwnerProfileDraft}
        onCancel={() => {
          setOwnerProfileDraft(ownerProfileToForm(data.owner_profile));
          setShowOwnerProfileModal(false);
        }}
        onSubmit={saveOwnerProfile}
      />

      <DiagnosticsModal
        open={showDiagnosticsModal}
        metrics={refreshMetricsSnapshotForUi}
        onResetRefreshMetrics={resetRefreshMetrics}
        onClose={() => setShowDiagnosticsModal(false)}
      />

      <SettingsModal
        open={showSettingsModal}
        chatTextSize={chatTextSize}
        onChatTextSizeChange={setChatTextSize}
        onClose={() => setShowSettingsModal(false)}
      />

      <div className={`main-view-slot ${activeMainView === "voice" ? "is-active" : "is-hidden"}`} aria-hidden={activeMainView !== "voice"}>
        <CallConsole
          agents={data.agents}
          agentWorkItems={data.agent_work_items}
          callSessions={data.call_sessions}
          callUtterances={data.call_utterances}
          callDispatches={data.call_dispatches}
          messages={data.messages}
          ownerProfile={data.owner_profile}
          activeCallThreadId={activeVoiceThreadId}
          setActiveCallThreadId={setActiveVoiceThreadId}
          openMobileSidebar={openMobileSidebarFromContent}
          onOpenWorkItem={openWorkItem}
        />
      </div>

      <div className={`main-view-slot ${activeMainView === "channels" ? "is-active" : "is-hidden"}`} aria-hidden={activeMainView !== "channels"}>
        <Conversation
          channel={channel}
          channels={data.channels}
          agents={data.agents}
          ownerProfile={data.owner_profile}
          agentActivities={data.agent_activities}
          agentRuns={data.agent_runs}
          agentWorkItems={data.agent_work_items}
          callSessions={data.call_sessions}
          callUtterances={data.call_utterances}
          callDispatches={data.call_dispatches}
          channelAgents={channelAgents}
          activeTab={activeTab}
          activeRoot={activeRoot}
          rootMessages={rootMessages}
          loadOlderRootMessages={loadOlderRootMessages}
          threadReplyCounts={threadReplyCounts}
          threadReplySummaries={threadReplySummaries}
          threadUnreadCounts={threadUnreadCounts}
          visibleTasks={visibleTasks}
          draft={draft}
          draftAttachments={draftAttachments}
          taskTitleDrafts={taskTitleDrafts}
          setActiveTab={setActiveTab}
          longTaskRefreshNonce={longTaskRefreshNonce}
          onLongTaskError={setAppError}
          setActiveThreadId={revealThread}
          openMobileSidebar={openMobileSidebarFromContent}
          canNavigateBack={canNavigateBack()}
          canNavigateForward={canNavigateForward()}
          navigateBack={() => navigateBack(() => {})}
          navigateForward={navigateForward}
          openToolBrowserPanel={toggleToolBrowserPanel}
          toolBrowserOpen={Boolean(toolBrowserTarget)}
          openChannelSettingsModal={() => setShowChannelSettingsModal(true)}
          deleteChannel={deleteChannel}
          openChannelAgentsModal={() => setShowChannelAgentsModal(true)}
          taskForMessage={taskForMessage}
          setTaskTitleDraft={setTaskTitleDraft}
          saveTaskTitle={saveTaskTitle}
          claimTask={claimTask}
          updateTaskStatus={updateTaskStatus}
          openTask={openTask}
          setDraft={setDraft}
          onAgentMentionSelected={addRootAgentMentionBinding}
          addDraftAttachments={(files) => appendDraftAttachments(files, "root")}
          removeDraftAttachment={(id) => updateRootComposerDraft(activeChannelId, (current) => ({
            ...current,
            attachments: current.attachments.filter((item) => item.id !== id),
          }))}
          sendRootMessage={sendRootMessage}
          openAgentDetail={(agent) => openAgentDetail(agent.id)}
          onOpenWorkItem={openWorkItem}
          openLocalLink={openLocalLink}
          openArtifact={openArtifact}
          shareBaseUrl={shareBaseUrl}
          savedMessageIds={savedMessageIds}
          todoMessageIds={todoMessageIds}
          focusedMessageId={focusedMessageId}
          onToggleMessageSaved={setMessageSaved}
          onToggleMessageTodo={setMessageTodo}
        />
      </div>

      {activeMainView === "channels" && selectedAgent ? (
        <AgentDetailDrawer
          agent={selectedAgent}
          agents={data.agents}
          activeRun={selectedAgentRun}
          phase={selectedAgentPhase}
          activities={selectedAgentActivities}
          performance={selectedAgentPerformance}
          workItems={selectedAgentWorkItems}
          reminders={data.reminders}
          channels={data.channels}
          messages={data.messages}
          onClose={closeSelectedAgent}
          onDelete={deleteAgent}
          onEdit={(agent) => {
            startEditAgent(agent);
          }}
          onOpenWorkItem={(item, focusedMessageIdOverride) => {
            openWorkItem(item, focusedMessageIdOverride);
            setSelectedAgentId(null);
          }}
          onCancelWorkItem={cancelWorkItem}
          onRetryWorkItem={retryWorkItem}
          onForwardWorkItem={forwardWorkItem}
          onResizeStart={startAgentDrawerResize}
        />
      ) : activeMainView === "channels" && showThread && (
        <ThreadPanel
          channel={channel}
          channels={data.channels}
          agents={data.agents}
          channelAgents={channelAgents}
          ownerProfile={data.owner_profile}
          agentActivities={data.agent_activities}
          agentRuns={data.agent_runs}
          agentWorkItems={data.agent_work_items}
          activeRoot={activeRoot}
          activeTask={activeTask}
          replies={replies}
          unreadCount={activeThreadId ? threadUnreadCounts[activeThreadId] ?? 0 : 0}
          taskTitleDrafts={taskTitleDrafts}
          replyDraft={replyDraft}
          replyAttachments={replyAttachments}
          onClose={closeThreadPanel}
          setTaskTitleDraft={setTaskTitleDraft}
          saveTaskTitle={saveTaskTitle}
          claimTask={claimTask}
          updateTaskStatus={updateTaskStatus}
          onCancelWorkItem={cancelWorkItem}
          setReplyDraft={setReplyDraft}
          onAgentMentionSelected={addReplyAgentMentionBinding}
          addReplyAttachments={(files) => appendDraftAttachments(files, "reply")}
          removeReplyAttachment={(id) => updateReplyComposerDraft(activeThreadId, (current) => ({
            ...current,
            attachments: current.attachments.filter((item) => item.id !== id),
          }))}
          sendReply={sendReply}
          openAgentDetail={(agent) => openAgentDetail(agent.id)}
          onOpenWorkItem={openWorkItem}
          openLocalLink={openLocalLink}
          openArtifact={openArtifact}
          shareBaseUrl={shareBaseUrl}
          savedMessageIds={savedMessageIds}
          todoMessageIds={todoMessageIds}
          focusedMessageId={focusedMessageId}
          onToggleMessageSaved={setMessageSaved}
          onToggleMessageTodo={setMessageTodo}
          onResizeStart={startThreadResize}
        />
      )}

      <ToolBrowserPanel
        target={toolBrowserTarget}
        onTargetChange={saveToolBrowserTarget}
        onClose={closeToolBrowserPanel}
        onResizeStart={startToolBrowserResize}
      />

      <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
        <button
          type="button"
          className={showMobileSidebar && mobileSidebarFocus === "home" ? "active" : ""}
          onClick={openMobileHome}
        >
          <Home size={20} />
          <span>Home</span>
        </button>
        <button
          type="button"
          className={`${showActivityFeedModal ? "active" : ""} ${activityFeedUnreadCount ? "has-unread" : ""}`}
          onClick={openActivityFeedModal}
        >
          <span className="mobile-bottom-nav-icon">
            <Inbox size={20} />
            {activityFeedUnreadCount > 0 && <strong>{activityFeedUnreadCount}</strong>}
          </span>
          <span>Activity</span>
        </button>
        <button
          type="button"
          className={`${showSavedModal ? "active" : ""} ${savedUnreadCount ? "has-unread" : ""}`}
          onClick={openSavedModal}
        >
          <span className="mobile-bottom-nav-icon">
            <Bookmark size={20} />
            {savedUnreadCount > 0 && <strong>{savedUnreadCount}</strong>}
          </span>
          <span>Saved</span>
        </button>
        <button
          type="button"
          className={activeMainView === "voice" ? "active" : ""}
          onClick={openVoiceConsole}
        >
          <Phone size={20} />
          <span>Voice</span>
        </button>
        <button
          type="button"
          className={showSearchModal ? "active" : ""}
          onClick={openSearchModal}
        >
          <Search size={20} />
          <span>Search</span>
        </button>
      </nav>

      {appError && (
        <div className="app-toast error" role="alert">
          <span>{appError}</span>
          <button onClick={() => setAppError(null)} aria-label="Dismiss error">Dismiss</button>
        </div>
      )}

      <CreateChannelModal
        open={showCreateChannelModal}
        channelName={newChannel}
        nameError={newChannelNameError}
        agents={data.agents}
        selectedAgentIds={newChannelAgentIds}
        submitting={createChannelSubmitting}
        onChange={(value) => {
          setNewChannel(value);
          setNewChannelNameSubmitError(null);
        }}
        onToggleAgent={(agentId, member) => {
          setNewChannelAgentIds((current) => {
            const next = new Set(current);
            if (member) next.add(agentId);
            else next.delete(agentId);
            return next;
          });
        }}
        onCreateAgent={() => {
          setAgentDraft(newAgentDraft());
          setReturnToCreateChannelAfterAgent(true);
          createAgentOpenedFromMobileHomeRef.current = false;
          setNewChannelNameSubmitError(null);
          setShowCreateChannelModal(false);
          setShowCreateAgentModal(true);
        }}
        onCancel={() => {
          setShowCreateChannelModal(false);
          createChannelOpenedFromMobileHomeRef.current = false;
          setReturnToCreateChannelAfterAgent(false);
          setNewChannelNameSubmitError(null);
          setNewChannelAgentIds(new Set());
        }}
        onSubmit={createChannel}
      />

      <ChannelSettingsModal
        open={showChannelSettingsModal}
        channel={channel}
        agents={data.agents}
        channelMemberIds={channelMemberIds}
        nameDraft={channelNameDraft}
        descriptionDraft={channelDescriptionDraft}
        onNameChange={setChannelNameDraft}
        onDescriptionChange={setChannelDescriptionDraft}
        onSetMember={setChannelMember}
        onDelete={deleteChannel}
        onCancel={() => setShowChannelSettingsModal(false)}
        onSave={saveChannel}
      />

      <ConfirmModal
        open={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? ""}
        body={confirmRequest?.body ?? ""}
        confirmLabel={confirmRequest?.confirmLabel ?? "Confirm"}
        onCancel={() => setConfirmRequest(null)}
        onConfirm={confirmRequest?.onConfirm ?? (() => {})}
      />

      <ChannelAgentsModal
        open={showChannelAgentsModal}
        channel={channel}
        agents={data.agents}
        channelMemberIds={channelMemberIds}
        onSetMember={setChannelMember}
        onCreateAgent={() => {
          setAgentDraft(newAgentDraft());
          setReturnToCreateChannelAfterAgent(false);
          createAgentOpenedFromMobileHomeRef.current = false;
          setShowChannelAgentsModal(false);
          setShowCreateAgentModal(true);
        }}
        onClose={() => setShowChannelAgentsModal(false)}
      />

      <AgentFormModal
        open={showCreateAgentModal}
        title="Add Agent"
        form={agentDraft}
        runtimeChecks={runtimeChecks}
        submitLabel="Add agent"
        createMode
        onChange={setAgentDraft}
        onRuntimeChange={updateDraftRuntime}
        onCancel={() => {
          const shouldReturnToCreateChannel = returnToCreateChannelAfterAgent;
          setAgentDraft(newAgentDraft());
          setShowCreateAgentModal(false);
          setReturnToCreateChannelAfterAgent(false);
          createAgentOpenedFromMobileHomeRef.current = false;
          if (shouldReturnToCreateChannel) {
            setShowCreateChannelModal(true);
          }
        }}
        onSubmit={createAgent}
      />

      <AgentFormModal
        open={Boolean(editingAgentId)}
        title="Edit Agent"
        form={agentEdit}
        runtimeChecks={runtimeChecks}
        submitLabel="Save"
        showNotes
        onChange={setAgentEdit}
        onRuntimeChange={updateEditRuntime}
        onCancel={cancelEditAgent}
        onSubmit={saveAgent}
      />

    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
