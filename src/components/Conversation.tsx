import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Activity,
  CheckCircle2,
  ChevronRight,
  Clock,
  Flag,
  Hash,
  Bookmark,
  BriefcaseBusiness,
  LayoutList,
  ListTodo,
  ListTree,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  PanelRightOpen,
  Phone,
  PhoneOff,
  RotateCcw,
  Send,
  Settings,
  Square,
  Trash2,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useAutoGrowTextarea } from "../hooks/useAutoGrowTextarea";
import { useCallModeSubmit } from "../hooks/useCallModeSubmit";
import { useCallModeRecorder } from "../hooks/useCallModeRecorder";
import { useMentionPicker } from "../hooks/useMentionPicker";
import { insertTextAtSelection, isImeComposing } from "../input-utils";
import { useHybridVoiceInput } from "../hooks/useHybridVoiceInput";
import { copyText } from "../clipboard";
import { APP_DISPLAY_NAME } from "../branding";
import { isCompactFollowupMessage, wasEdited } from "../message-grouping";
import { messageShareLink, messageToMarkdown } from "../message-share";
import { apiInvoke } from "../apiClient";
import { callModeStatusText } from "../callModeTimeline";
import { buildCallTurns } from "../callModeTurns";
import { buildCallWorkBoardItems, callWorkBoardStatusLabel } from "../callModeWorkBoard";
import { Agent, AgentActivity, AgentRun, AgentWorkItem, Artifact, CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult, Channel, DraftAttachment, LongTaskListItem, Message, OwnerProfile, TASK_STATUSES, Task, ThreadReplySummary } from "../types";
import { agentForMessageSender, deletedAgentForMessageSender, displayNameForSender, formatClockTime, formatDateDivider, formatTime, isSameCalendarDay, ownerAsAvatarAgent, visibleAgentDescription, visibleChannelDescription } from "../ui-utils";
import { ActivityProgressDock, activeProgressByAgent } from "./ActivityProgressDock";
import { AgentAvatar, AgentAvatarWithProfile } from "./AgentAvatar";
import { DraftAttachmentsPreview } from "./DraftAttachmentsPreview";
import { MessageActionMenu } from "./MessageActionMenu";
import { MessageAttachments } from "./MessageAttachments";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageMarkdown, type LocalEntityLinkTarget } from "./MessageMarkdown";
import { TaskAssigneePicker } from "./TaskAssigneePicker";
import { LongTaskPanel } from "./LongTaskPanel";

type ConversationProps = {
  channel: Channel | null;
  channels: Channel[];
  agents: Agent[];
  ownerProfile: OwnerProfile;
  agentActivities: AgentActivity[];
  agentRuns: AgentRun[];
  agentWorkItems: AgentWorkItem[];
  callSessions: CallSession[];
  callUtterances: CallUtterance[];
  callDispatches: CallDispatch[];
  channelAgents: Agent[];
  activeTab: "chat" | "tasks" | "longTasks";
  activeRoot: Message | null;
  rootMessages: Message[];
  loadOlderRootMessages: () => Promise<void>;
  threadReplyCounts: Record<string, number>;
  threadReplySummaries: Record<string, ThreadReplySummary>;
  threadUnreadCounts: Record<string, number>;
  visibleTasks: Task[];
  draft: string;
  draftAttachments: DraftAttachment[];
  taskTitleDrafts: Record<string, string>;
  setActiveTab: (tab: "chat" | "tasks" | "longTasks") => void;
  longTaskRefreshNonce: number;
  onLongTaskError: (message: string) => void;
  setActiveThreadId: (threadId: string | null) => void;
  openMobileSidebar: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  navigateBack: () => void;
  navigateForward: () => void;
  openToolBrowserPanel: () => void;
  toolBrowserOpen: boolean;
  openChannelSettingsModal: () => void;
  deleteChannel: () => void;
  openChannelAgentsModal: () => void;
  taskForMessage: (messageId: string) => Task | null;
  setTaskTitleDraft: (task: Task, title: string) => void;
  saveTaskTitle: (task: Task) => void;
  claimTask: (task: Task, agentId: string) => void;
  updateTaskStatus: (task: Task, status: string) => void;
  openTask: (task: Task) => void;
  setDraft: (value: string) => void;
  onAgentMentionSelected: (agent: Agent) => void;
  addDraftAttachments: (files: FileList | File[]) => void;
  removeDraftAttachment: (id: string) => void;
  sendRootMessage: (asTask?: boolean) => void;
  openAgentDetail: (agent: Agent) => void;
  onOpenWorkItem: (item: AgentWorkItem, focusedMessageIdOverride?: string | null) => void;
  openLocalLink: (target: LocalEntityLinkTarget) => void;
  openArtifact: (artifact: Artifact) => void;
  shareBaseUrl: string | null;
  savedMessageIds: Set<string>;
  todoMessageIds: Set<string>;
  focusedMessageId: string | null;
  onToggleMessageSaved: (message: Message, saved: boolean) => void;
  onToggleMessageTodo: (message: Message, todo: boolean) => void;
};

type MessageMenuState = {
  x: number;
  y: number;
  message: Message;
} | null;

const CHANNEL_MESSAGE_PREVIEW_LINES = 24;
const CHANNEL_MESSAGE_PREVIEW_CHARS = 4000;
const CALL_SPEECH_CHUNK_CHARS = 160;
const MESSAGE_CARD_INTERACTIVE_TARGET_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  ".message-artifacts",
  ".message-attachments",
].join(",");

function taskStatusLabel(status: string) {
  return status.replace("_", " ");
}

function replyingAgentsLabel(progress: ReturnType<typeof activeProgressByAgent>) {
  if (progress.length === 0) return "";
  if (progress.length === 1) return `${progress[0].agent.display_name} is replying`;
  return `${progress.length} agents are replying`;
}

function shouldCollapseChannelMessage(body: string) {
  const text = body.trim();
  if (!text) return false;
  return text.split("\n").length > CHANNEL_MESSAGE_PREVIEW_LINES || text.length > CHANNEL_MESSAGE_PREVIEW_CHARS;
}

function closeUnbalancedCodeFence(body: string) {
  const fenceMatches = body.match(/(^|\n)```/g);
  if (!fenceMatches || fenceMatches.length % 2 === 0) return body;
  return `${body.replace(/\s+$/, "")}\n\`\`\``;
}

function channelMessagePreview(body: string) {
  const text = body.trim();
  const lines = text.split("\n");
  const linePreview = lines.slice(0, CHANNEL_MESSAGE_PREVIEW_LINES).join("\n");
  const preview = linePreview.length > CHANNEL_MESSAGE_PREVIEW_CHARS
    ? `${linePreview.slice(0, CHANNEL_MESSAGE_PREVIEW_CHARS).replace(/\s+\S*$/, "")}`
    : linePreview;
  return closeUnbalancedCodeFence(preview);
}

function isInteractiveMessageClick(event: ReactMouseEvent<HTMLElement>) {
  if (event.nativeEvent.composedPath().some((node) => (
    node instanceof Element && node.matches(MESSAGE_CARD_INTERACTIVE_TARGET_SELECTOR)
  ))) {
    return true;
  }
  return event.target instanceof Element
    && Boolean(event.target.closest(MESSAGE_CARD_INTERACTIVE_TARGET_SELECTOR));
}

function longTaskNeedsApproval(item: LongTaskListItem) {
  const status = item.monitor?.status ?? "";
  return !item.archived && (status.includes("批准") || status.includes("approval"));
}

function formatVoiceElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatCallDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function callDurationMs(session: CallSession | null, now: number) {
  if (!session) return null;
  const startedAt = new Date(session.started_at).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const endedAt = session.ended_at ? new Date(session.ended_at).getTime() : now;
  return Math.max(0, (Number.isFinite(endedAt) ? endedAt : now) - startedAt);
}

function isPendingConfirmationDispatch(dispatch: CallDispatch | null): dispatch is CallDispatch {
  if (!dispatch) return false;
  if (dispatch.ack_status !== "needs_confirmation") return false;
  return !["superseded", "ignored", "failed", "compensated"].includes(dispatch.status);
}

type CallSpeechPolicy = "queue" | "barge-in";

type QueuedCallSpeech = {
  text: string;
};

type PendingCallAckSpeech = {
  key: string;
  text: string | null;
};

type PendingCallConfirmation = {
  dispatch: CallDispatch;
  utterance: CallUtterance;
  targetLabel: string;
};

type CallConfirmationRow = {
  utterance: CallUtterance;
  dispatch: CallDispatch | null;
};

function normalizeCallSpeechText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function callSpeechChunks(text: string) {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > CALL_SPEECH_CHUNK_CHARS) {
    const windowText = rest.slice(0, CALL_SPEECH_CHUNK_CHARS);
    const breakIndex = Math.max(
      windowText.lastIndexOf("。"),
      windowText.lastIndexOf("！"),
      windowText.lastIndexOf("？"),
      windowText.lastIndexOf("；"),
      windowText.lastIndexOf(";"),
      windowText.lastIndexOf("，"),
      windowText.lastIndexOf(","),
    );
    const splitAt = breakIndex >= 48 ? breakIndex + 1 : CALL_SPEECH_CHUNK_CHARS;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function callAckSpeechText(result: CallUtteranceSubmitResult) {
  const ackText = result.ack_text?.trim();
  if (
    !ackText
    || result.dispatch.status === "ignored"
    || result.utterance.status === "ignored"
  ) {
    return null;
  }
  return normalizeCallSpeechText(ackText);
}

function callDispatchSpeechText(dispatch: CallDispatch) {
  const ackText = dispatch.ack_text?.trim();
  if (
    !ackText
    || dispatch.intent === "coordinator_pending"
    || dispatch.intent === "worker_feedback"
    || ["queued", "dispatching", "superseded", "ignored", "failed"].includes(dispatch.status)
  ) {
    return null;
  }
  return normalizeCallSpeechText(ackText);
}

function latestExistingCallAckSequence(
  sessionId: string | null,
  callUtterances: CallUtterance[],
  callDispatches: CallDispatch[],
  maxSequence = Number.POSITIVE_INFINITY,
) {
  if (!sessionId) return 0;
  let latestSequence = 0;
  for (const utterance of callUtterances) {
    if (utterance.session_id !== sessionId) continue;
    if (Number.isFinite(utterance.sequence) && utterance.sequence <= maxSequence) {
      latestSequence = Math.max(latestSequence, utterance.sequence);
    }
  }
  for (const dispatch of callDispatches) {
    if (dispatch.session_id !== sessionId) continue;
    if (Number.isFinite(dispatch.utterance_sequence) && dispatch.utterance_sequence <= maxSequence) {
      latestSequence = Math.max(latestSequence, dispatch.utterance_sequence);
    }
  }
  return latestSequence;
}

function compareCallConfirmationRows(left: CallConfirmationRow, right: CallConfirmationRow) {
  const sequenceDelta = left.utterance.sequence - right.utterance.sequence;
  if (sequenceDelta !== 0) return sequenceDelta;
  return new Date(left.utterance.created_at).getTime() - new Date(right.utterance.created_at).getTime();
}

function buildCallConfirmationRows(
  session: CallSession | null,
  callUtterances: CallUtterance[],
  callDispatches: CallDispatch[],
  submitResults: CallUtteranceSubmitResult[],
) {
  if (!session) return [];

  const canonicalDispatchByUtterance = new Map(
    callDispatches
      .filter((dispatch) => dispatch.session_id === session.id)
      .map((dispatch) => [dispatch.utterance_id, dispatch]),
  );
  const submitResultByUtterance = new Map(
    submitResults
      .filter((result) => result.session.id === session.id)
      .map((result) => [result.utterance.id, result]),
  );
  const rows = new Map<string, CallConfirmationRow>();

  for (const utterance of callUtterances.filter((item) => item.session_id === session.id)) {
    const receipt = submitResultByUtterance.get(utterance.id);
    rows.set(utterance.id, {
      utterance,
      dispatch: canonicalDispatchByUtterance.get(utterance.id) ?? receipt?.dispatch ?? null,
    });
  }

  for (const result of submitResultByUtterance.values()) {
    if (rows.has(result.utterance.id)) continue;
    rows.set(result.utterance.id, {
      utterance: result.utterance,
      dispatch: result.dispatch,
    });
  }

  return Array.from(rows.values()).sort(compareCallConfirmationRows);
}

export function Conversation({
  channel,
  channels,
  agents,
  ownerProfile,
  agentActivities,
  agentRuns,
  agentWorkItems,
  callSessions,
  callUtterances,
  callDispatches,
  channelAgents,
  activeTab,
  activeRoot,
  rootMessages,
  loadOlderRootMessages,
  threadReplyCounts,
  threadReplySummaries,
  threadUnreadCounts,
  visibleTasks,
  draft,
  draftAttachments,
  taskTitleDrafts,
  setActiveTab,
  longTaskRefreshNonce,
  onLongTaskError,
  setActiveThreadId,
  openMobileSidebar,
  canNavigateBack,
  canNavigateForward,
  navigateBack,
  navigateForward,
  openToolBrowserPanel,
  toolBrowserOpen,
  openChannelSettingsModal,
  deleteChannel,
  openChannelAgentsModal,
  taskForMessage,
  setTaskTitleDraft,
  saveTaskTitle,
  claimTask,
  updateTaskStatus,
  openTask,
  setDraft,
  onAgentMentionSelected,
  addDraftAttachments,
  removeDraftAttachment,
  sendRootMessage,
  openAgentDetail,
  onOpenWorkItem,
  openLocalLink,
  openArtifact,
  shareBaseUrl,
  savedMessageIds,
  todoMessageIds,
  focusedMessageId,
  onToggleMessageSaved,
  onToggleMessageTodo,
}: ConversationProps) {
  const [sendAsTask, setSendAsTask] = useState(false);
  const [isComposerDragOver, setIsComposerDragOver] = useState(false);
  const [showChannelActions, setShowChannelActions] = useState(false);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState>(null);
  const [showMessageBackToBottom, setShowMessageBackToBottom] = useState(false);
  const [longTaskApprovalCount, setLongTaskApprovalCount] = useState(0);
  const [expandedChannelMessageIds, setExpandedChannelMessageIds] = useState<Set<string>>(() => new Set());
  const [callDurationNow, setCallDurationNow] = useState(() => Date.now());
  const [isCallAssistantSpeaking, setIsCallAssistantSpeaking] = useState(false);
  const [callSpeechQueueDepth, setCallSpeechQueueDepth] = useState(0);
  const [callConfirmationCorrectionDraft, setCallConfirmationCorrectionDraft] = useState("");
  const [callTypedUtteranceDraft, setCallTypedUtteranceDraft] = useState("");
  const composerDragDepthRef = useRef(0);
  const voiceButtonHandledAtRef = useRef(0);
  const taskToggleHandledAtRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageListContentRef = useRef<HTMLDivElement | null>(null);
  const messageListBottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const bottomScrollTimeoutRef = useRef<number | null>(null);
  const olderRootLoadInFlightRef = useRef(false);
  const shouldFollowMessagesRef = useRef(true);
  const userMessageScrollUntilRef = useRef(0);
  const messageListMetricsRef = useRef({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const channelActionsRef = useRef<HTMLDivElement | null>(null);
  const isDm = channel?.kind === "dm";
  const dmAgent = isDm ? agents.find((agent) => agent.id === channel?.dm_agent_id) ?? null : null;
  const mentionableAgents = isDm ? agents : channelAgents;
  const agentMentionLabels = useMemo(() => Object.fromEntries(
    agents.map((agent) => [agent.handle.toLowerCase(), agent.display_name || agent.handle]),
  ), [agents]);
  function openLinkedAgentDetail(handle: string) {
    const agent = agents.find((candidate) => candidate.handle.toLowerCase() === handle.toLowerCase());
    if (agent) openAgentDetail(agent);
  }
  const {
    mentionState,
    mentionIndex,
    mentionCandidates,
    refreshMentionState,
    chooseMention,
    handleMentionKeyDown,
    closeMentionPicker,
    focusComposer,
  } = useMentionPicker({
    agents: mentionableAgents,
    channels,
    value: draft,
    setValue: setDraft,
    onAgentMentionSelected,
    textareaRef,
  });
  const insertVoiceTranscript = useCallback((text: string) => {
    const textarea = textareaRef.current;
    const next = insertTextAtSelection(draft, text, textarea?.selectionStart, textarea?.selectionEnd);
    setDraft(next.value);
    refreshMentionState(next.value, next.cursor);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }, [draft, refreshMentionState, setDraft]);
  const voiceInput = useHybridVoiceInput({ onFinalTranscript: insertVoiceTranscript });
  useAutoGrowTextarea(textareaRef, draft);
  const activeReplyProgressByRoot = useMemo<Record<string, ReturnType<typeof activeProgressByAgent>>>(() => {
    if (!channel) return {};
    return Object.fromEntries(
      rootMessages
        .map((message) => [
          message.id,
          activeProgressByAgent(
            [],
            agentActivities,
            agentRuns,
            agentWorkItems,
            agents,
            channel.id,
            message.id,
          ),
        ] as const)
        .filter(([, progress]) => progress.length > 0),
    );
  }, [agentActivities, agentRuns, agentWorkItems, agents, channel, rootMessages]);
  const lastRootMessage = rootMessages[rootMessages.length - 1] ?? null;
  const activeTasks = visibleTasks.filter((task) => task.status !== "done");
  const reviewTasks = visibleTasks.filter((task) => task.status === "in_review");
  const unassignedTasks = visibleTasks.filter((task) => task.status !== "done" && !task.assignee_id);
  const assignedTasks = visibleTasks.filter((task) => task.assignee_id || task.status === "done");
  const taskAssigneeOptions = channelAgents.length > 0 ? channelAgents : agents;
  const channelAgentPreview = channelAgents.slice(0, 3);
  const surfaceLabel = channel
    ? isDm
      ? `DM with @${dmAgent?.handle || "agent"}`
      : `#${channel.name}`
    : APP_DISPLAY_NAME;
  function isMessageListAtBottom(element: HTMLDivElement) {
    return messageListDistanceFromBottom(element) < 32;
  }

  function wasMessageListPreviouslyAtBottom() {
    const metrics = messageListMetricsRef.current;
    if (metrics.scrollHeight === 0 && metrics.clientHeight === 0) return true;
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < 32;
  }

  function messageListDistanceFromBottom(element: HTMLDivElement) {
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  }

  function rememberMessageListMetrics(element: HTMLDivElement) {
    messageListMetricsRef.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    };
  }

  function cancelPendingMessageBottomScroll() {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    if (bottomScrollTimeoutRef.current !== null) {
      window.clearTimeout(bottomScrollTimeoutRef.current);
      bottomScrollTimeoutRef.current = null;
    }
  }

  function isUserScrollingMessages() {
    return Date.now() < userMessageScrollUntilRef.current;
  }

  function stopFollowingMessages(element = messageListRef.current) {
    userMessageScrollUntilRef.current = Date.now() + 650;
    shouldFollowMessagesRef.current = false;
    cancelPendingMessageBottomScroll();
    if (element) rememberMessageListMetrics(element);
    setShowMessageBackToBottom(Boolean(channel) && element ? !isMessageListAtBottom(element) : false);
  }

  function isPointerOnMessageListScrollbar(event: ReactPointerEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const scrollbarWidth = element.offsetWidth - element.clientWidth;
    if (scrollbarWidth <= 0) return false;
    return event.clientX >= element.getBoundingClientRect().right - scrollbarWidth - 2;
  }

  function scrollMessagesToBottomNow(behavior: ScrollBehavior = "auto") {
    const element = messageListRef.current;
    if (!element) return;
    userMessageScrollUntilRef.current = 0;
    element.scrollTo({ top: element.scrollHeight, behavior });
    setShowMessageBackToBottom(false);
    if (behavior === "auto") {
      shouldFollowMessagesRef.current = true;
      rememberMessageListMetrics(element);
    }
  }

  function scrollMessagesToBottom(behavior: ScrollBehavior = "auto") {
    scrollMessagesToBottomNow(behavior);
    if (behavior !== "auto") return;
    cancelPendingMessageBottomScroll();
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      if (shouldFollowMessagesRef.current) scrollMessagesToBottomNow();
    });
    bottomScrollTimeoutRef.current = window.setTimeout(() => {
      bottomScrollTimeoutRef.current = null;
      if (shouldFollowMessagesRef.current) scrollMessagesToBottomNow();
    }, 50);
  }

  function handleMessageListScroll() {
    const element = messageListRef.current;
    if (!element) return;
    if (activeTab === "chat" && element.scrollTop < 96 && !olderRootLoadInFlightRef.current && rootMessages.length > 0) {
      olderRootLoadInFlightRef.current = true;
      const previousScrollHeight = element.scrollHeight;
      void loadOlderRootMessages().finally(() => {
        window.requestAnimationFrame(() => {
          const list = messageListRef.current;
          if (list) {
            list.scrollTop += list.scrollHeight - previousScrollHeight;
            rememberMessageListMetrics(list);
          }
          olderRootLoadInFlightRef.current = false;
        });
      });
    }
    const atBottom = isMessageListAtBottom(element);
    const layoutChanged =
      messageListMetricsRef.current.scrollHeight !== element.scrollHeight
      || messageListMetricsRef.current.clientHeight !== element.clientHeight;
    const userScrolling = isUserScrollingMessages();
    const reachedScrollEnd = Math.abs(messageListDistanceFromBottom(element)) <= 1;
    let shouldShowBackToBottom = Boolean(channel) && !atBottom && !shouldFollowMessagesRef.current;
    if (atBottom && (!userScrolling || reachedScrollEnd)) {
      userMessageScrollUntilRef.current = 0;
      shouldFollowMessagesRef.current = true;
      shouldShowBackToBottom = false;
    } else if (!userScrolling && shouldFollowMessagesRef.current && layoutChanged && wasMessageListPreviouslyAtBottom()) {
      scrollMessagesToBottom();
      shouldShowBackToBottom = false;
    }
    setShowMessageBackToBottom((current) => current === shouldShowBackToBottom ? current : shouldShowBackToBottom);
    rememberMessageListMetrics(element);
  }

  function handleMessageListWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.deltaY >= 0) return;
    stopFollowingMessages();
  }

  function handleMessageListPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isPointerOnMessageListScrollbar(event)) return;
    stopFollowingMessages(event.currentTarget);
  }

  function handleMessageListTouchMove() {
    stopFollowingMessages();
  }

  function handleMessageListContentLoad() {
    if (!shouldFollowMessagesRef.current) return;
    scrollMessagesToBottom();
  }

  function returnMessagesToBottom() {
    shouldFollowMessagesRef.current = true;
    setShowMessageBackToBottom(false);
    scrollMessagesToBottom("smooth");
    window.requestAnimationFrame(() => {
      scrollMessagesToBottom();
      shouldFollowMessagesRef.current = true;
      setShowMessageBackToBottom(false);
    });
  }

  function hasSelectedText() {
    return Boolean(window.getSelection()?.toString().trim());
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposing(event)) return;
    if (handleMentionKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitComposer();
    }
  }

  // Mobile WebViews (iOS WKWebView, Android WebView) dismiss the soft keyboard
  // when a tap blurs the focused textarea, and the first tap is consumed by the
  // dismissal so the button doesn't fire. Calling preventDefault on mousedown
  // (which is non-passive in React) keeps focus on the textarea so the click
  // fires reliably on the first tap.
  function preserveComposerFocus(event: ReactMouseEvent<HTMLElement>) {
    if (textareaRef.current && document.activeElement === textareaRef.current) {
      event.preventDefault();
    }
  }

  function toggleVoiceInput() {
    if (!channel || !voiceInput.isSupported) return;
    if (voiceInput.isListening) voiceInput.stop();
    else if (voiceInput.isStarting) voiceInput.abort();
    else voiceInput.start();
  }

  function handleVoicePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse") return;
    if (!channel || !voiceInput.isSupported) return;
    event.preventDefault();
    voiceButtonHandledAtRef.current = Date.now();
    toggleVoiceInput();
  }

  function handleVoiceClick() {
    if (Date.now() - voiceButtonHandledAtRef.current < 600) return;
    voiceButtonHandledAtRef.current = Date.now();
    toggleVoiceInput();
  }

  // Toggle eagerly on pointer/mouse down so the active highlight flips before
  // the synthesized click. We dedupe via a timestamp ref and let click handle
  // keyboard activation (Enter/Space), where down events do not fire.
  function handleTaskToggleMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (Date.now() - taskToggleHandledAtRef.current < 600) return;
    preserveComposerFocus(event);
    if (!channel) return;
    taskToggleHandledAtRef.current = Date.now();
    setSendAsTask((current) => !current);
  }

  function handleTaskTogglePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse") return;
    if (!channel) return;
    event.preventDefault();
    event.stopPropagation();
    taskToggleHandledAtRef.current = Date.now();
    setSendAsTask((current) => !current);
  }

  function handleTaskToggleClick() {
    if (!channel) return;
    if (Date.now() - taskToggleHandledAtRef.current < 600) return;
    setSendAsTask((current) => !current);
  }

  function submitComposer() {
    if (!channel || (!draft.trim() && draftAttachments.length === 0)) return;
    sendRootMessage(isDm ? false : sendAsTask);
    closeMentionPicker();
    focusComposer();
  }

  function shouldOpenThreadFromMessageClick() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function hasDraggedFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleComposerDragEnter(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    event.dataTransfer.dropEffect = channel ? "copy" : "none";
    if (channel) setIsComposerDragOver(true);
  }

  function handleComposerDragOver(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = channel ? "copy" : "none";
    if (channel) setIsComposerDragOver(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setIsComposerDragOver(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = 0;
    setIsComposerDragOver(false);
    if (!channel || event.dataTransfer.files.length === 0) return;
    addDraftAttachments(event.dataTransfer.files);
    focusComposer();
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    if (!channel) return;
    addDraftAttachments(imageFiles);
    focusComposer();
  }

  function renderReplyParticipantAvatar(message: Message) {
    const agent = agentForMessageSender(message, agents);
    if (agent) return <AgentAvatar agent={agent} size="sm" title={`@${agent.handle}`} showStatus={false} />;
    const deletedAgent = deletedAgentForMessageSender(message);
    if (deletedAgent) return <AgentAvatar agent={deletedAgent} size="sm" title={`@${deletedAgent.handle} has been deleted`} showStatus={false} />;
    if (message.sender_role === "owner") {
      return <AgentAvatar agent={ownerAsAvatarAgent(ownerProfile)} size="sm" showStatus={false} />;
    }
    return <span className="thread-reply-fallback-avatar">{message.sender_name.slice(0, 1)}</span>;
  }

  useEffect(() => {
    if (!isDm) return;
    setSendAsTask(false);
    if (activeTab === "tasks") setActiveTab("chat");
  }, [activeTab, isDm, setActiveTab]);

  useEffect(() => {
    if (activeTab === "longTasks") return;
    let cancelled = false;
    async function loadLongTaskApprovalCount() {
      try {
        const items = await apiInvoke<LongTaskListItem[]>("long_task_list");
        if (cancelled) return;
        setLongTaskApprovalCount(items.filter(longTaskNeedsApproval).length);
      } catch {
        if (!cancelled) setLongTaskApprovalCount(0);
      }
    }
    loadLongTaskApprovalCount();
    const timer = window.setInterval(loadLongTaskApprovalCount, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTab, longTaskRefreshNonce]);

  useEffect(() => {
    composerDragDepthRef.current = 0;
    setIsComposerDragOver(false);
    setShowChannelActions(false);
    setMessageMenu(null);
    voiceInput.abort();
  }, [channel?.id]);

  useEffect(() => {
    if (!showChannelActions) return;
    function handlePointerDown(event: PointerEvent) {
      const root = channelActionsRef.current;
      if (!root) return;
      const target = event.target as Node | null;
      if (target && root.contains(target)) return;
      setShowChannelActions(false);
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setShowChannelActions(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showChannelActions]);

  function handleChannelActionsBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setShowChannelActions(false);
  }

  function shouldUseNativeMessageSelection() {
    return window.matchMedia("(hover: none)").matches;
  }

  async function copyMessageMarkdown(message: Message) {
    await copyText(messageToMarkdown(message, surfaceLabel));
    setMessageMenu(null);
  }

  async function copyMessageLink(message: Message) {
    await copyText(messageShareLink(message, shareBaseUrl));
    setMessageMenu(null);
  }

  function toggleChannelMessageExpanded(messageId: string) {
    setExpandedChannelMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  useLayoutEffect(() => {
    shouldFollowMessagesRef.current = true;
    setShowMessageBackToBottom(false);
    scrollMessagesToBottom();
  }, [channel?.id]);

  useEffect(() => {
    setExpandedChannelMessageIds(new Set());
  }, [channel?.id]);

  useEffect(() => () => {
    cancelPendingMessageBottomScroll();
  }, []);

  useEffect(() => {
    if (activeTab !== "chat") return;
    const root = messageListRef.current;
    const content = messageListContentRef.current;
    const bottomAnchor = messageListBottomAnchorRef.current;
    if (!root || !content || !bottomAnchor) return;
    function keepBottomVisible() {
      const list = messageListRef.current;
      if (!list) return;
      if (shouldFollowMessagesRef.current && !isUserScrollingMessages()) {
        scrollMessagesToBottom();
      } else {
        rememberMessageListMetrics(list);
      }
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepBottomVisible);
    const intersectionObserver = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
        if (!shouldFollowMessagesRef.current) return;
        if (entries.some((entry) => !entry.isIntersecting || entry.intersectionRatio < 1)) {
          keepBottomVisible();
        }
      }, { root, threshold: 1 });
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(keepBottomVisible);
    observer?.observe(root);
    observer?.observe(content);
    intersectionObserver?.observe(bottomAnchor);
    mutationObserver?.observe(content, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", keepBottomVisible);
    return () => {
      observer?.disconnect();
      intersectionObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", keepBottomVisible);
    };
  }, [activeTab, channel?.id]);

  useLayoutEffect(() => {
    if (!shouldFollowMessagesRef.current) return;
    scrollMessagesToBottom();
  }, [activeTab, channel?.id, rootMessages.length, lastRootMessage?.id, lastRootMessage?.updated_at, lastRootMessage?.delivery_state]);

  useLayoutEffect(() => {
    if (activeTab !== "chat") return;
    if (shouldFollowMessagesRef.current) scrollMessagesToBottom();
  }, [activeRoot?.id, activeTab]);

  useEffect(() => {
    if (!focusedMessageId) return;
    const element = messageListRef.current?.querySelector<HTMLElement>(`[data-message-id="${focusedMessageId}"]`);
    if (!element) return;
    shouldFollowMessagesRef.current = false;
    userMessageScrollUntilRef.current = Date.now() + 650;
    cancelPendingMessageBottomScroll();
    element.scrollIntoView({ block: "center" });
    window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (!list) return;
      rememberMessageListMetrics(list);
      setShowMessageBackToBottom(!isMessageListAtBottom(list));
    });
  }, [channel?.id, focusedMessageId]);

  const showVoiceCaptureBar = voiceInput.isRecordedInput
    && (voiceInput.isListening || voiceInput.isRequestingPermission || voiceInput.isTranscribing || Boolean(voiceInput.error));
  const voiceCaptureTitle = voiceInput.error
    ? "Voice input failed"
    : voiceInput.isTranscribing
    ? "Transcribing"
    : voiceInput.isListening
    ? "Recording"
    : "Preparing microphone";
  const voiceCaptureDetail = voiceInput.error
    || voiceInput.statusMessage
    || (voiceInput.isListening ? "Tap Stop when finished." : "");
  const voiceCaptureElapsed = formatVoiceElapsed(voiceInput.recordingElapsedMs);

  return (
    <section className="conversation">
      <header className="topbar">
        <button
          type="button"
          className="mobile-nav-button"
          aria-label="Back to navigation"
          onClick={openMobileSidebar}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="desktop-history-controls" aria-label="Navigation history">
          <button
            type="button"
            className="desktop-history-button"
            aria-label="Go back"
            title="Back"
            disabled={!canNavigateBack}
            onClick={navigateBack}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            type="button"
            className="desktop-history-button"
            aria-label="Go forward"
            title="Forward"
            disabled={!canNavigateForward}
            onClick={navigateForward}
          >
            <ArrowRight size={17} />
          </button>
        </div>
        <div className="channel-title">
          {isDm && dmAgent ? (
            <button
              type="button"
              className="hash-card dm-card dm-agent-detail-trigger"
              aria-label={`View @${dmAgent.handle} details`}
              onClick={() => openAgentDetail(dmAgent)}
            >
              <AgentAvatarWithProfile agent={dmAgent} />
            </button>
          ) : (
            <span className="hash-card">
              <Hash />
            </span>
          )}
          <div>
            <h1>{isDm ? dmAgent?.display_name || "Direct Message" : channel?.name || "No channel"}</h1>
            {isDm ? (
              <p title={dmAgent ? `@${dmAgent.handle} · ${dmAgent.runtime} · ${dmAgent.status}` : undefined}>
                {dmAgent ? `@${dmAgent.handle} · ${dmAgent.runtime}` : "Agent no longer exists"}
              </p>
            ) : (
              <p>{channel ? visibleChannelDescription(channel.description) : "Create a channel from the sidebar"}</p>
            )}
          </div>
        </div>
        <div className="channel-header-actions" ref={channelActionsRef} onBlur={handleChannelActionsBlur}>
          <button
            type="button"
            className={`channel-action-trigger ${toolBrowserOpen ? "active" : ""}`}
            title={toolBrowserOpen ? "Close Tool Browser" : "Open Tool Browser"}
            aria-label={toolBrowserOpen ? "Close Tool Browser" : "Open Tool Browser"}
            aria-pressed={toolBrowserOpen}
            onClick={() => {
              setShowChannelActions(false);
              openToolBrowserPanel();
            }}
          >
            <PanelRightOpen size={18} />
          </button>
          {channel && !isDm && (
            <>
            <button
              type="button"
              className="channel-agent-count-trigger"
              title="Manage channel agents"
              aria-label="Manage channel agents"
              onClick={() => {
                setShowChannelActions(false);
                openChannelAgentsModal();
              }}
            >
              {channelAgentPreview.length > 0 ? (
                <span className="channel-agent-preview" aria-hidden="true">
                  {channelAgentPreview.map((agent) => (
                    <span key={agent.id}>
                      <AgentAvatar agent={agent} size="sm" showStatus={false} title={`@${agent.handle}`} />
                    </span>
                  ))}
                </span>
              ) : (
                <Users size={16} />
              )}
              <span>{channelAgents.length}</span>
            </button>
            <button
              type="button"
              className={`channel-action-trigger ${showChannelActions ? "active" : ""}`}
              title="Channel actions"
              aria-label="Channel actions"
              aria-expanded={showChannelActions}
              onClick={() => setShowChannelActions((current) => !current)}
            >
              <Settings size={18} />
            </button>
            {showChannelActions && (
              <div className="channel-actions-menu">
                <button
                  type="button"
                  onClick={() => {
                    setShowChannelActions(false);
                    openChannelSettingsModal();
                  }}
                >
                  <Settings size={15} />
                  <span>Channel settings</span>
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setShowChannelActions(false);
                    deleteChannel();
                  }}
                >
                  <Trash2 size={15} />
                  <span>Delete channel</span>
                </button>
              </div>
            )}
            </>
          )}
        </div>
      </header>

      <div className="tabs">
        <button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>
          <MessageSquare size={16} /> Chat
        </button>
        {!isDm && (
          <button className={activeTab === "tasks" ? "active" : ""} onClick={() => setActiveTab("tasks")}>
            <LayoutList size={16} /> Tasks
          </button>
        )}
        <button className={activeTab === "longTasks" ? "active" : ""} onClick={() => setActiveTab("longTasks")}>
          <ListTree size={16} /> Long Tasks
          {longTaskApprovalCount > 0 ? (
            <span className="tab-alert-dot approval" aria-label={`${longTaskApprovalCount} long task approval${longTaskApprovalCount === 1 ? "" : "s"} waiting`}>
              {longTaskApprovalCount > 9 ? "9+" : longTaskApprovalCount}
            </span>
          ) : null}
        </button>
      </div>

      {activeTab === "chat" ? (
        <div
          ref={messageListRef}
          className="message-list"
          onScroll={handleMessageListScroll}
          onWheelCapture={handleMessageListWheel}
          onPointerDownCapture={handleMessageListPointerDown}
          onTouchMoveCapture={handleMessageListTouchMove}
          onLoadCapture={handleMessageListContentLoad}
        >
          <div ref={messageListContentRef} className="message-list-content">
            {channel ? (
              rootMessages.length > 0 ? (
                <div className="beginning">
                  {isDm ? `Beginning of your DM with @${dmAgent?.handle || "agent"}` : `Beginning of #${channel.name}`}
                </div>
              ) : (
                <div className="empty-state">
                  <MessageSquare size={34} />
                  <h2>{isDm ? "No DM messages yet" : "No messages yet"}</h2>
                  <p>
                    {isDm
                      ? "Send a message here to talk directly with this agent."
                      : "Send a root message from the composer. Replies belong in the right thread pane."}
                  </p>
                </div>
              )
            ) : (
              <div className="empty-state">
                <Hash size={34} />
                <h2>No channels yet</h2>
                <p>Create a channel in the left sidebar, then send messages or tasks.</p>
              </div>
            )}
            <ActivityProgressDock
              messages={rootMessages}
              activities={agentActivities}
              runs={agentRuns}
              workItems={agentWorkItems}
              agents={agents}
              channelId={channel?.id ?? null}
              threadRootId={null}
              onOpenWorkItem={onOpenWorkItem}
            />
            {rootMessages.map((message, index) => {
            const linkedTask = taskForMessage(message.id);
            const replyCount = threadReplyCounts[message.id] ?? 0;
            const replySummary = threadReplySummaries[message.id] ?? null;
            const unreadReplyCount = threadUnreadCounts[message.id] ?? 0;
            const activeReplyProgress = activeReplyProgressByRoot[message.id] ?? [];
            const hasActiveReplyProgress = activeReplyProgress.length > 0;
            const replyingLabel = replyingAgentsLabel(activeReplyProgress);
            const activeReplyAgentIds = new Set(activeReplyProgress.map((progress) => progress.agent.id).filter(Boolean));
            const replyParticipants = (replySummary?.participants ?? [])
              .filter((participant) => !participant.sender_agent_id || !activeReplyAgentIds.has(participant.sender_agent_id))
              .slice(0, Math.max(0, 3 - activeReplyProgress.length));
            const messageAgent = isDm ? null : agentForMessageSender(message, agents);
            const deletedMessageAgent = isDm || messageAgent ? null : deletedAgentForMessageSender(message);
            const isSaved = savedMessageIds.has(message.id);
            const isTodo = todoMessageIds.has(message.id);
            const isCompact = isCompactFollowupMessage(message, rootMessages[index - 1]);
            const showDateDivider = index === 0 || !isSameCalendarDay(message.created_at, rootMessages[index - 1]?.created_at ?? "");
            const isLongChannelMessage = shouldCollapseChannelMessage(message.body);
            const isChannelMessageExpanded = expandedChannelMessageIds.has(message.id);
            const visibleMessageBody = isLongChannelMessage && !isChannelMessageExpanded
              ? channelMessagePreview(message.body)
              : message.body;
            const showMessageBody = message.delivery_state !== "streaming" || visibleMessageBody.trim().length > 0;
            if (message.sender_role === "system") {
              return (
                <Fragment key={message.id}>
                  {showDateDivider && (
                    <div className="message-date-divider" role="separator">
                      <span />
                      <time dateTime={message.created_at}>{formatDateDivider(message.created_at)}</time>
                      <span />
                    </div>
                  )}
                  <article className="system-message">
                    <div className="system-message-line">
                      <MessageMarkdown body={message.body} agentMentionLabels={agentMentionLabels} onLocalAgentLink={openLinkedAgentDetail} onLocalLink={openLocalLink} />
                      <time>{formatTime(message.created_at)}</time>
                    </div>
                  </article>
                </Fragment>
              );
            }
            return (
              <Fragment key={message.id}>
                {showDateDivider && (
                  <div className="message-date-divider" role="separator">
                    <span />
                    <time dateTime={message.created_at}>{formatDateDivider(message.created_at)}</time>
                    <span />
                  </div>
                )}
                <article
                  data-message-id={message.id}
                  data-sender-role={message.sender_role}
                  className={`message-card ${isCompact ? "compact" : ""} ${message.id === activeRoot?.id ? "focused" : ""} ${isSaved ? "saved" : ""}`}
                  data-jump-focused={focusedMessageId === message.id ? "true" : "false"}
                  onClick={(event) => {
                    if (isInteractiveMessageClick(event)) return;
                    if (hasSelectedText()) return;
                    if (shouldOpenThreadFromMessageClick()) setActiveThreadId(message.id);
                  }}
                  onContextMenu={(event) => {
                    if (shouldUseNativeMessageSelection()) return;
                    event.preventDefault();
                    setMessageMenu({ x: event.clientX, y: event.clientY, message });
                  }}
                >
                  {isCompact ? (
                    <time className="message-compact-time" dateTime={message.created_at}>
                      {formatClockTime(message.created_at)}
                    </time>
                  ) : messageAgent ? (
                    <button
                      type="button"
                      className="message-agent-avatar-trigger"
                      aria-label={`View @${messageAgent.handle} details`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openAgentDetail(messageAgent);
                      }}
                    >
                      <AgentAvatarWithProfile agent={messageAgent} />
                    </button>
                  ) : deletedMessageAgent ? (
                    <AgentAvatar
                      agent={deletedMessageAgent}
                      size="md"
                      title={`@${deletedMessageAgent.handle} has been deleted`}
                    />
                  ) : message.sender_role === "owner" ? (
                    <AgentAvatar agent={ownerAsAvatarAgent(ownerProfile)} size="md" showStatus={false} />
                  ) : (
                    <div className="avatar">{message.sender_name.slice(0, 1)}</div>
                  )}
                  <div className="message-body">
                    {!isCompact && (
                      <div className="meta">
                        <strong>{displayNameForSender(message, ownerProfile)}</strong>
                        <span>{message.sender_role}</span>
                        <time>{formatTime(message.created_at)}</time>
                        {wasEdited(message) && <span className="edited-indicator">edited</span>}
                        {linkedTask && (
                          <mark>
                            <CheckCircle2 size={14} /> #{linkedTask.number} · {linkedTask.status.replace("_", " ")}
                          </mark>
                        )}
                        <button
                          type="button"
                          className={`message-save-button mobile-message-save-tag ${isSaved ? "saved" : ""}`}
                          title={isSaved ? "Unsave message" : "Save message"}
                          aria-label={isSaved ? "Unsave message" : "Save message"}
                          aria-pressed={isSaved}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleMessageSaved(message, !isSaved);
                          }}
                        >
                          <Bookmark size={14} />
                        </button>
                        <button
                          type="button"
                          className={`message-save-button message-todo-button mobile-message-save-tag ${isTodo ? "todo" : ""}`}
                          title={isTodo ? "Remove todo" : "Add todo"}
                          aria-label={isTodo ? "Remove todo" : "Add todo"}
                          aria-pressed={isTodo}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onToggleMessageTodo(message, !isTodo);
                          }}
                        >
                          <ListTodo size={14} />
                        </button>
                      </div>
                    )}
                    <div className="message-hover-actions" aria-label="Message actions">
                      <button
                        type="button"
                        data-tooltip={replyCount > 0 ? "View thread" : "Reply in thread"}
                        title={replyCount > 0 ? "View thread replies" : "Reply in thread"}
                        aria-label={replyCount > 0 ? "View thread replies" : "Reply in thread"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveThreadId(message.id);
                        }}
                      >
                        <MessageSquare size={14} />
                      </button>
                      <button
                        type="button"
                        className={isSaved ? "saved" : ""}
                        data-tooltip={isSaved ? "Unsave" : "Save"}
                        title={isSaved ? "Unsave message" : "Save message"}
                        aria-label={isSaved ? "Unsave message" : "Save message"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleMessageSaved(message, !isSaved);
                        }}
                      >
                        <Bookmark size={14} />
                      </button>
                      <button
                        type="button"
                        className={isTodo ? "todo" : ""}
                        data-tooltip={isTodo ? "Untodo" : "Todo"}
                        title={isTodo ? "Remove todo" : "Add todo"}
                        aria-label={isTodo ? "Remove todo" : "Add todo"}
                        aria-pressed={isTodo}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleMessageTodo(message, !isTodo);
                        }}
                      >
                        <ListTodo size={14} />
                      </button>
                    </div>
                    {showMessageBody && (
                      <>
                        <div className={isLongChannelMessage && !isChannelMessageExpanded ? "message-long-preview collapsed" : "message-long-preview"}>
                          <MessageMarkdown body={visibleMessageBody} agentMentionLabels={agentMentionLabels} onLocalAgentLink={openLinkedAgentDetail} onLocalLink={openLocalLink} />
                        </div>
                        {isLongChannelMessage && (
                          <button
                            type="button"
                            className="message-expand-button"
                            aria-expanded={isChannelMessageExpanded}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleChannelMessageExpanded(message.id);
                            }}
                          >
                            {isChannelMessageExpanded ? "Show less" : "Show more"}
                          </button>
                        )}
                      </>
                    )}
                    <MessageAttachments attachments={message.attachments} />
                    <MessageArtifacts artifacts={message.artifacts} onOpenArtifact={openArtifact} />
                    {message.delivery_state === "sending" && (
                      <div className="message-stream-state sending">Sending...</div>
                    )}
                    {message.delivery_state === "error" && (
                      <div className="message-stream-state error">Refreshing response</div>
                    )}
                    {(hasActiveReplyProgress || (replyCount > 0 && replySummary)) && (
                      <button
                        type="button"
                        className={`thread-reply-summary ${hasActiveReplyProgress ? "active-reply" : ""} ${unreadReplyCount > 0 ? "has-unread" : ""}`}
                        title="View thread replies"
                        aria-label={hasActiveReplyProgress
                          ? `${replyingLabel}. View thread`
                          : `View ${replyCount} ${replyCount === 1 ? "reply" : "replies"} in thread${unreadReplyCount > 0 ? `, ${unreadReplyCount} new` : ""}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveThreadId(message.id);
                        }}
                      >
                        <div className="thread-reply-avatars">
                          {activeReplyProgress.slice(0, 3).map((progress) => (
                            <span key={`active:${progress.key}`}>
                              <AgentAvatar agent={progress.agent} size="sm" showStatus={false} />
                            </span>
                          ))}
                          {replyParticipants.map((participant) => (
                            <span key={`${participant.sender_role}:${participant.sender_agent_id ?? participant.sender_name}`}>
                              {renderReplyParticipantAvatar(participant)}
                            </span>
                          ))}
                        </div>
                        <strong>
                          {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Replying"}
                          {unreadReplyCount > 0 && (
                            <span className="thread-reply-unread-badge">{unreadReplyCount > 9 ? "9+" : unreadReplyCount}</span>
                          )}
                        </strong>
                        {(hasActiveReplyProgress || replySummary?.latest) && (
                          <span className="thread-reply-summary-action">
                            {hasActiveReplyProgress ? (
                              <span className="thread-reply-summary-status">{replyingLabel}</span>
                            ) : replySummary?.latest ? (
                              <time dateTime={replySummary.latest.created_at}>Last reply {formatTime(replySummary.latest.created_at)}</time>
                            ) : null}
                            <span className="thread-reply-summary-open">View thread</span>
                          </span>
                        )}
                        <ChevronRight className="thread-reply-summary-icon" size={18} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </article>
              </Fragment>
            );
            })}
            <div ref={messageListBottomAnchorRef} className="message-list-bottom-anchor" aria-hidden="true" />
          </div>
          {messageMenu && (
            <MessageActionMenu
              x={messageMenu.x}
              y={messageMenu.y}
              isSaved={savedMessageIds.has(messageMenu.message.id)}
              isTodo={todoMessageIds.has(messageMenu.message.id)}
              onCopyLink={() => copyMessageLink(messageMenu.message)}
              onCopyMarkdown={() => copyMessageMarkdown(messageMenu.message)}
              onToggleSaved={() => {
                onToggleMessageSaved(messageMenu.message, !savedMessageIds.has(messageMenu.message.id));
                setMessageMenu(null);
              }}
              onToggleTodo={() => {
                onToggleMessageTodo(messageMenu.message, !todoMessageIds.has(messageMenu.message.id));
                setMessageMenu(null);
              }}
              onClose={() => setMessageMenu(null)}
            />
          )}
          {channel && showMessageBackToBottom && (
            <button type="button" className="message-back-to-bottom" onClick={returnMessagesToBottom}>
              <ArrowDown size={15} />
              Back to bottom
            </button>
          )}
        </div>
      ) : activeTab === "tasks" ? (
        <div className="task-board">
          <section className="task-board-summary" aria-label="Task summary">
            <div>
              <strong>{visibleTasks.length}</strong>
              <span>Total</span>
            </div>
            <div>
              <strong>{activeTasks.length}</strong>
              <span>Active</span>
            </div>
            <div>
              <strong>{reviewTasks.length}</strong>
              <span>Review</span>
            </div>
            <div>
              <strong>{unassignedTasks.length}</strong>
              <span>Unassigned</span>
            </div>
          </section>
          {visibleTasks.length === 0 && (
            <div className="empty-state">
              <LayoutList size={34} />
              <h2>No tasks in this channel</h2>
              <p>Create tracked work from chat by sending a message in Task mode.</p>
            </div>
          )}
          {visibleTasks.length > 0 && (
            <div className="task-sections">
              {unassignedTasks.length > 0 && (
                <section className="task-queue-section unassigned" aria-label="Unassigned task queue">
                  <div className="task-queue-heading">
                    <div>
                      <span>Queue</span>
                      <strong>Unassigned</strong>
                    </div>
                    <mark>{unassignedTasks.length}</mark>
                  </div>
                  <div className="task-list">
                    {unassignedTasks.map((task) => renderTaskCard(task))}
                  </div>
                </section>
              )}
              {assignedTasks.length > 0 && (
                <section className="task-queue-section" aria-label="Assigned tasks">
                  <div className="task-queue-heading">
                    <div>
                      <span>Work</span>
                      <strong>Assigned</strong>
                    </div>
                    <mark>{assignedTasks.length}</mark>
                  </div>
                  <div className="task-list">
                    {assignedTasks.map((task) => renderTaskCard(task))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      ) : (
        <LongTaskPanel
          refreshNonce={longTaskRefreshNonce}
          onError={onLongTaskError}
          onApprovalCountChange={setLongTaskApprovalCount}
        />
      )}

      {activeTab === "chat" && (
        <footer
          className={`composer ${isComposerDragOver ? "drag-over" : ""}`}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
        >
          {mentionState && mentionCandidates.length > 0 && (
            <div className="mention-picker">
              {mentionCandidates.map((candidate, index) => (
                <button
                  key={`${candidate.kind}:${candidate.id}`}
                  className={index === mentionIndex ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseMention(candidate);
                  }}
                >
                  {candidate.kind === "agent" ? (
                    <>
                      <AgentAvatar agent={candidate.agent} size="sm" title={`@${candidate.agent.handle}`} />
                      <span className="mention-picker-copy">
                        <strong>{candidate.agent.display_name}</strong>
                        <small>@{candidate.agent.handle}</small>
                        {visibleAgentDescription(candidate.agent.description) && <em>{visibleAgentDescription(candidate.agent.description)}</em>}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mention-picker-channel-icon" aria-hidden="true">
                        <Hash size={16} />
                      </span>
                      <span className="mention-picker-copy">
                        <strong>#{candidate.channel.name}</strong>
                        <small>Channel</small>
                        {visibleChannelDescription(candidate.channel.description) && <em>{visibleChannelDescription(candidate.channel.description)}</em>}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="file-input-hidden"
            onChange={(event) => {
              if (event.target.files) addDraftAttachments(event.target.files);
              event.target.value = "";
            }}
          />
          <DraftAttachmentsPreview attachments={draftAttachments} onRemove={removeDraftAttachment} />
          {showVoiceCaptureBar && (
            <div className={`voice-capture-bar ${voiceInput.isListening ? "recording" : ""} ${voiceInput.error ? "has-error" : ""}`}>
              <div className="voice-capture-state">
                <span className="voice-capture-dot" aria-hidden="true" />
                <div>
                  <strong>{voiceCaptureTitle}</strong>
                  <span>{voiceCaptureDetail}</span>
                </div>
              </div>
              <time>{voiceCaptureElapsed}</time>
              <div className="voice-capture-actions">
                <button
                  type="button"
                  className="voice-capture-stop"
                  disabled={!voiceInput.isListening}
                  onMouseDown={preserveComposerFocus}
                  onClick={voiceInput.stop}
                >
                  <Square size={13} />
                  <span>Stop</span>
                </button>
                <button
                  type="button"
                  className="voice-capture-cancel"
                  onMouseDown={preserveComposerFocus}
                  onClick={voiceInput.abort}
                >
                  <X size={14} />
                  <span>{voiceInput.error ? "Dismiss" : "Cancel"}</span>
                </button>
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              refreshMentionState(event.target.value, event.target.selectionStart);
            }}
            onSelect={(event) => refreshMentionState(event.currentTarget.value, event.currentTarget.selectionStart)}
            onKeyDown={handleComposerKeyDown}
            onPaste={handleComposerPaste}
            disabled={!channel}
            placeholder={
              channel
                ? isDm
                  ? `Message @${dmAgent?.handle || "agent"}`
                  : `Message #${channel.name} - type @ or # to mention`
                : "Create a channel before messaging"
            }
          />
          <div className="composer-actions">
            <button
              type="button"
              className="attach-button"
              disabled={!channel}
              onMouseDown={preserveComposerFocus}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <button
              type="button"
              className={`voice-button ${voiceInput.isListening ? "active" : ""} ${voiceInput.isStarting ? "requesting" : ""}`}
              title={
                voiceInput.isSupported
                  ? voiceInput.isStarting
                    ? "Starting voice input"
                    : voiceInput.isListening
                    ? "Stop voice input"
                    : "Voice input"
                  : "Voice input is not supported in this WebView"
              }
              aria-label={voiceInput.isStarting ? "Starting voice input" : voiceInput.isListening ? "Stop voice input" : "Voice input"}
              aria-pressed={voiceInput.isListening || voiceInput.isStarting}
              disabled={!channel || !voiceInput.isSupported}
              onPointerDown={handleVoicePointerDown}
              onMouseDown={preserveComposerFocus}
              onClick={handleVoiceClick}
            >
              <Mic size={16} />
            </button>
            {!isDm && (
              <button
                type="button"
                className={`task-toggle ${sendAsTask ? "active" : ""}`}
                title={sendAsTask ? "Send next message as a normal message" : "Send next message as a task"}
                aria-label={sendAsTask ? "Send next message as a normal message" : "Send next message as a task"}
                aria-pressed={sendAsTask}
                disabled={!channel}
                onPointerDown={handleTaskTogglePointerDown}
                onMouseDown={handleTaskToggleMouseDown}
                onClick={handleTaskToggleClick}
              >
                <Flag size={15} />
                <span>Task</span>
              </button>
            )}
            <button
              className="send"
              title={sendAsTask && !isDm ? "Create task" : "Send message"}
              aria-label={sendAsTask && !isDm ? "Create task" : "Send message"}
              disabled={!channel || (!draft.trim() && draftAttachments.length === 0)}
              onMouseDown={preserveComposerFocus}
              onClick={submitComposer}
            >
              <Send size={17} />
            </button>
          </div>
          {!showVoiceCaptureBar && (voiceInput.statusMessage || voiceInput.interimTranscript || voiceInput.error) && (
            <div className={`voice-input-status ${voiceInput.error ? "error" : ""}`}>
              {voiceInput.error || voiceInput.interimTranscript || voiceInput.statusMessage}
            </div>
          )}
        </footer>
      )}
    </section>
  );

  function renderTaskCard(task: Task) {
    const assignee = agents.find((agent) => agent.id === task.assignee_id) ?? null;
    return (
      <article className={`task-card ${task.assignee_id ? "" : "unassigned"}`} key={task.id}>
        <div className="task-card-main">
          <div className="task-card-head" onClick={() => openTask(task)}>
            <span>Task #{task.number}</span>
            <button type="button" className="task-open-thread" aria-label={`Open task #${task.number} thread`}>
              <MessageSquare size={14} />
            </button>
          </div>
          <input
            value={taskTitleDrafts[task.id] ?? task.title}
            onChange={(event) => setTaskTitleDraft(task, event.target.value)}
            onBlur={() => saveTaskTitle(task)}
            onKeyDown={(event) => {
              if (isImeComposing(event)) return;
              if (event.key === "Enter") saveTaskTitle(task);
            }}
          />
          <p>Updated {formatTime(task.updated_at)}</p>
        </div>
        <div className="task-controls">
          <TaskAssigneePicker
            agents={taskAssigneeOptions}
            assignee={assignee}
            disabled={task.status === "done"}
            done={task.status === "done"}
            onChange={(agentId) => claimTask(task, agentId)}
            taskNumber={task.number}
          />
          <div className="status-row" aria-label={`Task #${task.number} status`}>
            {TASK_STATUSES.map((status) => (
              <button
                type="button"
                key={status}
                className={task.status === status ? "active" : ""}
                data-state={status}
                onClick={() => updateTaskStatus(task, status)}
              >
                {taskStatusLabel(status)}
              </button>
            ))}
          </div>
        </div>
      </article>
    );
  }
}
