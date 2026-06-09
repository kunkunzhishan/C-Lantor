import {
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  Clock,
  Gauge,
  Laptop,
  Mic,
  MicOff,
  MonitorSpeaker,
  Phone,
  PhoneOff,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  CALL_TTS_VOICES,
  CALL_TTS_DEFAULT_GAP_MS,
  CALL_VOICE_LANGUAGES,
  normalizeCallTtsSettings,
  synthesizeCallTtsAudio,
  voicesForCallTtsProvider,
  type CallTtsProviderId,
  type CallTtsSettings,
  type CallVoiceLanguage,
} from "../callTts";
import { buildCallTurns, type CallTurn, type CallTurnEvent } from "../callModeTurns";
import { callModeStatusText } from "../callModeTimeline";
import { buildCallWorkBoardItems, callWorkBoardStatusLabel } from "../callModeWorkBoard";
import { useCallModeRecorder } from "../hooks/useCallModeRecorder";
import { useCallModeSubmit } from "../hooks/useCallModeSubmit";
import type { Agent, AgentWorkItem, CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult, Message, OwnerProfile } from "../types";
import { formatDateDivider, formatTime, isSameCalendarDay, ownerAsAvatarAgent } from "../ui-utils";
import {
  loadVoiceConsoleSettings,
  normalizeVoiceConsoleSettings,
  normalizeVoiceWakeSettings,
  saveVoiceConsoleSettings,
  type VoiceConsoleMode,
  type VoiceWakeSettings,
} from "../voiceConsoleSettings";
import { AgentAvatar } from "./AgentAvatar";
import { MessageMarkdown } from "./MessageMarkdown";

type CallConsoleProps = {
  agents: Agent[];
  agentWorkItems: AgentWorkItem[];
  callSessions: CallSession[];
  callUtterances: CallUtterance[];
  callDispatches: CallDispatch[];
  messages: Message[];
  ownerProfile: OwnerProfile;
  activeCallThreadId: string | null;
  setActiveCallThreadId: (threadId: string | null) => void;
  loadOlderCallHistory: () => Promise<number>;
  openMobileSidebar: () => void;
  onOpenWorkItem: (item: AgentWorkItem) => void;
};

const CALL_SPEECH_CHUNK_CHARS = 160;

type CallSpeechPolicy = "queue" | "barge-in" | "barge-in-resume";

type QueuedCallSpeech = {
  id: number;
  speechId: number;
  text: string;
  audioUrl: string | null;
  provider: CallTtsProviderId;
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

type CallWorkerReply = {
  id: string;
  speechKey: string;
  body: string;
  createdAt: string;
  workItem: AgentWorkItem;
};

const SILENT_CALL_DISPATCH_STATUSES = new Set(["queued", "dispatching", "superseded", "ignored", "failed", "compensated"]);

function callConsoleModeLabel(mode: string | null | undefined) {
  return mode === "wake_word" ? "Wake Word" : "Call";
}

function cancelBrowserCallSpeech() {
  if (
    typeof window !== "undefined"
    && "speechSynthesis" in window
    && window.speechSynthesis
  ) {
    window.speechSynthesis.cancel();
  }
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

function isCallWorkerReplyMessage(message: Message, workItem: AgentWorkItem) {
  if (message.delivery_state !== "complete") return false;
  if (!message.body.trim()) return false;
  if (!message.sender_agent_id || message.sender_agent_id !== workItem.agent_id) return false;
  if (workItem.run_id && message.stream_key.startsWith(workItem.run_id)) return true;
  return message.stream_key.startsWith(workItem.id);
}

function callWorkerReplies(
  sessionId: string | null,
  messages: Message[],
  agentWorkItems: AgentWorkItem[],
) {
  if (!sessionId) return [];
  const callWorkItems = agentWorkItems.filter((item) => item.call_session_id === sessionId && item.call_dispatch_id);
  const replies: CallWorkerReply[] = [];
  for (const workItem of callWorkItems) {
    const messageReplies = messages
      .filter((message) => isCallWorkerReplyMessage(message, workItem))
      .map((message) => ({
        id: message.id,
        speechKey: callWorkerReplySpeechKey(workItem),
        body: message.body,
        createdAt: message.created_at,
        workItem,
      }));
    replies.push(...messageReplies);
    const resultBody = workItem.result_body?.trim();
    if (messageReplies.length === 0 && resultBody && workItem.status === "done") {
      replies.push({
        id: `${workItem.id}:result_body`,
        speechKey: callWorkerReplySpeechKey(workItem),
        body: resultBody,
        createdAt: workItem.completed_at ?? workItem.updated_at,
        workItem,
      });
    }
  }
  return replies;
}

function callWorkerReplySpeechKey(workItem: AgentWorkItem) {
  return workItem.id;
}

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
      windowText.lastIndexOf(". "),
      windowText.lastIndexOf("; "),
      windowText.lastIndexOf(", "),
      windowText.lastIndexOf("，"),
    );
    const splitAt = breakIndex >= 48 ? breakIndex + 1 : CALL_SPEECH_CHUNK_CHARS;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isNoSpeechTranscriptionText(value: string | null | undefined) {
  const lower = (value ?? "").toLowerCase();
  return lower.includes("no speech")
    || lower.includes("speech was not detected")
    || lower.includes("emptytranscript")
    || lower.includes("wake word required")
    || lower.includes("waiting for the wake word")
    || lower.includes("等待唤醒词");
}

function isIgnoredNoSpeechTurn(turn: CallTurn) {
  return turn.status === "ignored"
    && !turn.transcript
    && isNoSpeechTranscriptionText(turn.transcriptionError)
    && (turn.audioDurationMs === null || turn.audioDurationMs <= 20_000);
}

function callAckSpeechText(result: CallUtteranceSubmitResult) {
  if (result.utterance.status === "ignored" || result.dispatch.status === "ignored") return null;
  if (
    result.utterance.status === "queued"
    || (result.dispatch.status === "queued" && !isSpeakableQueuedCallDispatch(result.dispatch))
  ) return null;
  if (isRoutineTranscriptionDiagnostic(result.utterance.transcription_error || result.dispatch.error)) return null;
  const ackText = result.ack_text || result.dispatch.ack_text || result.dispatch.status_text;
  if (!ackText) return null;
  if (isRoutineTranscriptionDiagnostic(ackText)) return null;
  return normalizeCallSpeechText(ackText);
}

function isWakeOnlyAckResult(result: CallUtteranceSubmitResult) {
  return result.session.mode === "wake_word"
    && result.utterance.status === "acknowledged"
    && result.dispatch.intent === "ack_only"
    && result.dispatch.status === "acknowledged"
    && result.work_item_id === null
    && normalizeCallSpeechText(result.dispatch.ack_text).length > 0;
}

function callDispatchSpeechText(dispatch: CallDispatch) {
  if (SILENT_CALL_DISPATCH_STATUSES.has(dispatch.status) && !isSpeakableQueuedCallDispatch(dispatch)) return null;
  if (dispatch.intent === "coordinator_pending") return null;
  if (isRoutineTranscriptionDiagnostic(dispatch.error)) return null;
  const ackText = dispatch.ack_text || dispatch.status_text;
  if (!ackText) return null;
  if (dispatch.intent === "worker_feedback") return null;
  if (isRoutineTranscriptionDiagnostic(ackText)) return null;
  return normalizeCallSpeechText(ackText);
}

function isSpeakableQueuedCallDispatch(dispatch: CallDispatch) {
  return dispatch.status === "queued"
    && (
      (
        dispatch.intent === "agent_work"
        && dispatch.outcome === "work_queued"
        && Boolean(dispatch.work_item_id)
      )
      || (
        dispatch.intent === "cancel_work"
        && dispatch.outcome === "work_cancel_requested"
      )
    );
}

function isRoutineTranscriptionDiagnostic(value: string | null | undefined) {
  const lower = (value ?? "").toLowerCase();
  if (!lower) return false;
  return lower.includes("no speech")
    || lower.includes("emptytranscript")
    || lower.includes("empty transcript")
    || lower.includes("emptyaudio")
    || lower.includes("empty audio")
    || lower.includes("transcription failed")
    || lower.includes("voice transcription")
    || lower.includes("speech recognition")
    || lower.includes("wake word required")
    || lower.includes("waiting for the wake word")
    || lower.includes("等待唤醒词")
    || lower.includes("转写失败")
    || lower.includes("语音识别");
}

function latestExistingCallAckSequence(
  sessionId: string,
  callUtterances: CallUtterance[],
  callDispatches: CallDispatch[],
  maxSequence: number,
) {
  let latest = 0;
  for (const utterance of callUtterances) {
    if (utterance.session_id !== sessionId) continue;
    if (!Number.isFinite(utterance.sequence) || utterance.sequence >= maxSequence) continue;
    latest = Math.max(latest, utterance.sequence);
  }
  for (const dispatch of callDispatches) {
    if (dispatch.session_id !== sessionId) continue;
    if (!Number.isFinite(dispatch.utterance_sequence) || dispatch.utterance_sequence >= maxSequence) continue;
    latest = Math.max(latest, dispatch.utterance_sequence);
  }
  return latest;
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
): CallConfirmationRow[] {
  if (!session) return [];
  const dispatchesByUtterance = new Map(
    callDispatches
      .filter((dispatch) => dispatch.session_id === session.id)
      .map((dispatch) => [dispatch.utterance_id, dispatch]),
  );
  for (const result of submitResults) {
    if (result.session.id !== session.id) continue;
    if (!dispatchesByUtterance.has(result.utterance.id)) {
      dispatchesByUtterance.set(result.utterance.id, result.dispatch);
    }
  }
  const rows = new Map<string, CallConfirmationRow>();
  for (const utterance of callUtterances.filter((item) => item.session_id === session.id)) {
    rows.set(utterance.id, {
      utterance,
      dispatch: dispatchesByUtterance.get(utterance.id) ?? null,
    });
  }
  for (const result of submitResults) {
    if (result.session.id !== session.id) continue;
    rows.set(result.utterance.id, {
      utterance: result.utterance,
      dispatch: dispatchesByUtterance.get(result.utterance.id) ?? result.dispatch,
    });
  }
  return Array.from(rows.values()).sort(compareCallConfirmationRows);
}

type CallMessageRow = {
  id: string;
  senderRole: "owner" | "agent" | "system";
  senderName: string;
  senderAgent: Agent | null;
  senderMeta: string;
  body: string;
  createdAt: string;
  tone?: string;
};

type CallThreadRow = {
  id: string;
  sequence: number;
  status: string;
  createdAt: string;
  root: CallMessageRow;
  replies: CallMessageRow[];
};

function compareCallSessionsByStart(left: CallSession, right: CallSession) {
  const startedDelta = new Date(left.started_at).getTime() - new Date(right.started_at).getTime();
  if (startedDelta !== 0) return startedDelta;
  return left.id.localeCompare(right.id);
}

function isVoiceConsoleSession(session: CallSession) {
  return session.thread_root_id === null && (session.channel_id === null || session.title === "Voice Console");
}

const callSystemAvatarAgent: Agent = {
  id: "call-system-agent",
  handle: "system",
  display_name: "System Agent",
  role: "Voice dispatcher",
  status: "idle",
  runtime: "",
  model: "",
  reasoning_effort: "",
  service_tier: "",
  avatar: "S",
  description: "Routes voice requests and reads worker results.",
  launch_command: "",
  working_directory: "",
  workspace_exists: false,
  workspace_memory_path: "",
  workspace_memory_exists: false,
  workspace_entries: [],
  daily_budget_micros: 0,
};

function callEventAgent(event: CallTurnEvent, agents: Agent[]) {
  if (!event.label.startsWith("@")) return null;
  const handle = event.label.match(/@([A-Za-z0-9_.-]+)/)?.[1] ?? null;
  if (!handle) return null;
  return agents.find((agent) => agent.handle === handle) ?? null;
}

function callEventSenderName(event: CallTurnEvent, agent: Agent | null) {
  if (agent) return agent.display_name || `@${agent.handle}`;
  if (event.label.startsWith("System")) return "System Agent";
  return event.label;
}

function callEventBody(event: CallTurnEvent) {
  if (!event.detail || event.detail === event.title) {
    return event.title;
  }
  if (event.title === "Worker task" || event.title === "Dispatch decision") {
    return event.detail;
  }
  return `**${event.title}**\n\n${event.detail}`;
}

function callEventSubtitle(event: CallTurnEvent) {
  if (event.label.startsWith("System -> ")) return event.label.replace("System -> ", "to ");
  return event.tone;
}

function callEventSenderRole(event: CallTurnEvent): "agent" | "system" {
  if (event.label === "System" && event.tone !== "done" && event.title.toLowerCase().includes("queue")) {
    return "system";
  }
  return "agent";
}

function buildCallThreadRows(turns: CallTurn[], agents: Agent[]): CallThreadRow[] {
  return turns.map((turn) => {
    const root: CallMessageRow = {
      id: `voice:${turn.id}`,
      senderRole: "owner",
      senderName: "You",
      senderAgent: null,
      senderMeta: `voice #${turn.sequence}`,
      body: callTurnRootBody(turn),
      createdAt: turn.createdAt,
      tone: turn.status,
    };
    const replies: CallMessageRow[] = [];
    for (const event of turn.events) {
      if (event.id === `user:${turn.id}`) continue;
      if (event.id.startsWith("user:")) {
        replies.push({
          id: event.id,
          senderRole: "owner",
          senderName: "You",
          senderAgent: null,
          senderMeta: `voice #${turn.sequence}`,
          body: event.title,
          createdAt: event.timestamp,
          tone: event.tone,
        });
        continue;
      }
      const senderRole = callEventSenderRole(event);
      const senderAgent = senderRole === "agent" ? callEventAgent(event, agents) : null;
      replies.push({
        id: event.id,
        senderRole,
        senderName: senderRole === "system" ? "System" : callEventSenderName(event, senderAgent),
        senderAgent,
        senderMeta: senderRole === "system" ? event.title : callEventSubtitle(event),
        body: callEventBody(event),
        createdAt: event.timestamp,
        tone: event.tone,
      });
    }
    return {
      id: turn.id,
      sequence: turn.sequence,
      status: turn.status,
      createdAt: turn.createdAt,
      root,
      replies,
    };
  });
}

function callTurnRootBody(turn: CallTurn) {
  if (turn.transcript) return turn.transcript;
  if (turn.transcriptionError) {
    const duration = turn.audioDurationMs !== null ? ` (${Math.round(turn.audioDurationMs / 1000)}s audio)` : "";
    if (isNoSpeechTranscriptionText(turn.transcriptionError)) {
      return `No speech detected${duration}`;
    }
    return `Voice transcription failed${duration}\n\n${turn.transcriptionError}`;
  }
  return "No transcript";
}

export function CallConsole({
  agents,
  agentWorkItems,
  callSessions,
  callUtterances,
  callDispatches,
  messages,
  ownerProfile,
  activeCallThreadId,
  setActiveCallThreadId,
  loadOlderCallHistory,
  openMobileSidebar,
  onOpenWorkItem,
}: CallConsoleProps) {
  const [callDurationNow, setCallDurationNow] = useState(() => Date.now());
  const [isCallAssistantSpeaking, setIsCallAssistantSpeaking] = useState(false);
  const [callConfirmationCorrectionDraft, setCallConfirmationCorrectionDraft] = useState("");
  const [callTypedUtteranceDraft, setCallTypedUtteranceDraft] = useState("");
  const [callThreadReplyDraft, setCallThreadReplyDraft] = useState("");
  const [isSubmittingTypedCallUtterance, setIsSubmittingTypedCallUtterance] = useState(false);
  const [isSubmittingCallThreadReply, setIsSubmittingCallThreadReply] = useState(false);
  const [voiceConsoleSettings, setVoiceConsoleSettingsState] = useState(loadVoiceConsoleSettings);
  const callTtsSettings = voiceConsoleSettings.tts;
  const callWakeSettings = useMemo<VoiceWakeSettings>(() => ({
    mode: voiceConsoleSettings.mode,
    wakeWords: voiceConsoleSettings.wakeWords,
  }), [voiceConsoleSettings.mode, voiceConsoleSettings.wakeWords]);
  const [showCallSettings, setShowCallSettings] = useState(false);
  const [callTtsStatus, setCallTtsStatus] = useState("");
  const [finalCallSpeechDrainSessionId, setFinalCallSpeechDrainSessionId] = useState<string | null>(null);
  const finalCallSpeechDrainSessionIdRef = useRef<string | null>(null);
  const callMessageListRef = useRef<HTMLDivElement | null>(null);
  const olderCallHistoryLoadInFlightRef = useRef(false);
  const allOlderCallHistoryLoadedRef = useRef(false);
  const surfaceCallSessions = useMemo(() => {
    return callSessions
      .filter(isVoiceConsoleSession)
      .sort(compareCallSessionsByStart);
  }, [callSessions]);
  const surfaceCallSession = useMemo(() => {
    const sessions = [...surfaceCallSessions].sort((left, right) =>
      new Date(right.started_at).getTime() - new Date(left.started_at).getTime()
    );
    return sessions.find((session) => session.status === "active") ?? sessions[0] ?? null;
  }, [surfaceCallSessions]);
  const callMode = useCallModeSubmit({
    channelId: null,
    threadRootId: null,
    title: "Voice Console",
    surfaceSession: surfaceCallSession,
    language: callTtsSettings.language,
    mode: callWakeSettings.mode,
    wakeWords: callWakeSettings.wakeWords,
  });
  const visibleCallSession = callMode.session ?? surfaceCallSession;
  const effectiveCallConsoleMode = visibleCallSession?.status === "active"
    ? (visibleCallSession.mode === "wake_word" ? "wake_word" : "call")
    : callWakeSettings.mode;
  const isCallWakeWordMode = effectiveCallConsoleMode === "wake_word";
  const callRecorder = useCallModeRecorder({
    echoGateActive: isCallAssistantSpeaking && !isCallWakeWordMode,
    liveSessionId: callMode.isLive ? callMode.session?.id ?? null : null,
    onSubmitAudio: callMode.submitRecordedUtterance,
  });
  const lastSpokenCallAckRef = useRef<string | null>(null);
  const callAckSpeechSessionIdRef = useRef<string | null>(null);
  const lastQueuedCallAckSequenceRef = useRef(0);
  const queuedCallAckKeysRef = useRef<Set<string>>(new Set());
  const pendingCallAckSpeechBySequenceRef = useRef<Map<number, PendingCallAckSpeech>>(new Map());
  const spokenCallWorkerMessageIdsRef = useRef<Set<string> | null>(null);
  const callSpeechQueueRef = useRef<QueuedCallSpeech[]>([]);
  const callSpeechReadyByJobIdRef = useRef<Map<number, QueuedCallSpeech>>(new Map());
  const callSpeechNextReadyJobIdRef = useRef(1);
  const callSpeechCurrentRef = useRef<QueuedCallSpeech | null>(null);
  const callSpeechSpeakingRef = useRef(false);
  const callSpeechDuckingRef = useRef(false);
  const callSpeechBlockedRef = useRef(false);
  const callSpeechUtteranceIdRef = useRef(0);
  const callSpeechAudioRef = useRef<HTMLAudioElement | null>(null);
  const callSpeechAudioUrlRef = useRef<string | null>(null);
  const callSpeechGapTimerRef = useRef<number | null>(null);
  const callSpeechJobIdRef = useRef(0);
  const callSpeechMessageIdRef = useRef(0);
  const callSpeechGenerationRef = useRef(0);
  const callTtsSettingsRef = useRef(callTtsSettings);
  callTtsSettingsRef.current = callTtsSettings;
  const canPlayCallSpeech = callMode.isLive || (
    callMode.session?.id != null
    && (
      finalCallSpeechDrainSessionId === callMode.session.id
      || finalCallSpeechDrainSessionIdRef.current === callMode.session.id
    )
  );
  callSpeechDuckingRef.current = callMode.isLive && callRecorder.isListening && !callRecorder.isMuted;
  callSpeechBlockedRef.current = callMode.isLive && !isCallWakeWordMode && callRecorder.isVoiceActive && !callRecorder.isMuted;

  const setCallTtsSettings = (next: CallTtsSettings) => {
    const normalized = normalizeVoiceConsoleSettings({
      ...voiceConsoleSettings,
      tts: normalizeCallTtsSettings(next),
    });
    callTtsSettingsRef.current = normalized.tts;
    setVoiceConsoleSettingsState(normalized);
    saveVoiceConsoleSettings(normalized);
  };

  const setCallWakeSettings = (next: VoiceWakeSettings) => {
    const normalized = normalizeVoiceConsoleSettings({
      ...voiceConsoleSettings,
      ...normalizeVoiceWakeSettings(next),
    });
    setVoiceConsoleSettingsState(normalized);
    saveVoiceConsoleSettings(normalized);
  };

  const setCallSpeechQueue = (queue: QueuedCallSpeech[]) => {
    callSpeechQueueRef.current = queue;
  };

  function clearCallSpeechGapTimer() {
    if (callSpeechGapTimerRef.current === null || typeof window === "undefined") return;
    window.clearTimeout(callSpeechGapTimerRef.current);
    callSpeechGapTimerRef.current = null;
  }

  function stopCurrentCallAudio(revokeUrl = true) {
    if (!callSpeechAudioRef.current) return;
    callSpeechAudioRef.current.onended = null;
    callSpeechAudioRef.current.onerror = null;
    callSpeechAudioRef.current.pause();
    callSpeechAudioRef.current.src = "";
    callSpeechAudioRef.current = null;
    if (revokeUrl && callSpeechAudioUrlRef.current) {
      URL.revokeObjectURL(callSpeechAudioUrlRef.current);
    }
    callSpeechAudioUrlRef.current = null;
  }

  function releaseQueuedCallSpeech(queue: QueuedCallSpeech[]) {
    for (const item of queue) {
      if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    }
  }

  function releasePendingCallSpeech() {
    releaseQueuedCallSpeech(Array.from(callSpeechReadyByJobIdRef.current.values()));
    callSpeechReadyByJobIdRef.current.clear();
    callSpeechNextReadyJobIdRef.current = callSpeechJobIdRef.current + 1;
  }

  function stopCallSpeech(options: { preserveFinalDrain?: boolean } = {}) {
    clearCallSpeechGapTimer();
    releaseQueuedCallSpeech(callSpeechQueueRef.current);
    releasePendingCallSpeech();
    setCallSpeechQueue([]);
    callSpeechSpeakingRef.current = false;
    callSpeechUtteranceIdRef.current += 1;
    callSpeechGenerationRef.current += 1;
    setIsCallAssistantSpeaking(false);
    stopCurrentCallAudio();
    callSpeechCurrentRef.current = null;
    cancelBrowserCallSpeech();
    if (!options.preserveFinalDrain) {
      finalCallSpeechDrainSessionIdRef.current = null;
      setFinalCallSpeechDrainSessionId(null);
    }
  }

  function finishCurrentCallSpeech() {
    stopCurrentCallAudio();
    callSpeechCurrentRef.current = null;
    callSpeechSpeakingRef.current = false;
    setIsCallAssistantSpeaking(false);
    if (callSpeechQueueRef.current.length === 0) {
      if (!callMode.isLive) {
        finalCallSpeechDrainSessionIdRef.current = null;
        setFinalCallSpeechDrainSessionId(null);
      }
      return;
    }
    const gapMs = CALL_TTS_DEFAULT_GAP_MS;
    if (gapMs <= 0 || typeof window === "undefined") {
      playNextCallSpeech();
      return;
    }
    clearCallSpeechGapTimer();
    callSpeechGapTimerRef.current = window.setTimeout(() => {
      callSpeechGapTimerRef.current = null;
      playNextCallSpeech();
    }, gapMs);
  }

  function playNextCallSpeech() {
    clearCallSpeechGapTimer();
    if (callSpeechSpeakingRef.current) return;
    if (callSpeechBlockedRef.current) return;
    const next = callSpeechQueueRef.current.shift();
    if (!next) {
      if (!callMode.isLive) {
        finalCallSpeechDrainSessionIdRef.current = null;
        setFinalCallSpeechDrainSessionId(null);
      }
      return;
    }
    callSpeechCurrentRef.current = next;
    callSpeechUtteranceIdRef.current += 1;
    const utteranceId = callSpeechUtteranceIdRef.current;
    if (next.audioUrl && typeof Audio !== "undefined") {
      const audio = new Audio(next.audioUrl);
      callSpeechAudioRef.current = audio;
      callSpeechAudioUrlRef.current = next.audioUrl;
      audio.volume = callSpeechDuckingRef.current ? 0.78 : 1;
      audio.onended = () => {
        if (utteranceId === callSpeechUtteranceIdRef.current) finishCurrentCallSpeech();
      };
      audio.onerror = () => {
        if (utteranceId === callSpeechUtteranceIdRef.current) finishCurrentCallSpeech();
      };
      callSpeechSpeakingRef.current = true;
      setIsCallAssistantSpeaking(true);
      cancelBrowserCallSpeech();
      void audio.play().catch(() => {
        if (utteranceId === callSpeechUtteranceIdRef.current) finishCurrentCallSpeech();
      });
      return;
    }

    if (
      typeof window === "undefined"
      || !("speechSynthesis" in window)
      || typeof SpeechSynthesisUtterance === "undefined"
    ) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.lang = callTtsSettingsRef.current.language;
    utterance.volume = callSpeechDuckingRef.current ? 0.78 : 1;
    utterance.rate = callTtsSettingsRef.current.rate;
    utterance.onend = () => {
      if (utteranceId === callSpeechUtteranceIdRef.current) finishCurrentCallSpeech();
    };
    utterance.onerror = () => {
      if (utteranceId === callSpeechUtteranceIdRef.current) finishCurrentCallSpeech();
    };
    callSpeechSpeakingRef.current = true;
    setIsCallAssistantSpeaking(true);
    stopCurrentCallAudio();
    cancelBrowserCallSpeech();
    window.speechSynthesis.speak(utterance);
  }

  function interruptCurrentCallSpeechForVoice(options: { requeueCurrent?: boolean } = {}) {
    const requeueCurrent = options.requeueCurrent ?? true;
    const current = callSpeechCurrentRef.current;
    callSpeechCurrentRef.current = null;
    callSpeechSpeakingRef.current = false;
    callSpeechUtteranceIdRef.current += 1;
    setIsCallAssistantSpeaking(false);
    if (current && requeueCurrent) {
      setCallSpeechQueue([current, ...callSpeechQueueRef.current]);
    }
    stopCurrentCallAudio(false);
    cancelBrowserCallSpeech();
    return current;
  }

  function queueCallSpeechAtFront(text: string, resumeQueue: QueuedCallSpeech[]) {
    const trimmed = normalizeCallSpeechText(text);
    const settings = callTtsSettingsRef.current;
    const chunks = callSpeechChunks(trimmed);
    if (
      chunks.length === 0
      || typeof window === "undefined"
      || (settings.provider === "browser" && (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined"))
    ) {
      setCallSpeechQueue([...resumeQueue, ...callSpeechQueueRef.current]);
      playNextCallSpeech();
      return false;
    }
    const speechId = ++callSpeechMessageIdRef.current;
    if (settings.provider === "browser") {
      const wakeSpeech = chunks.map((chunk) => ({
        id: ++callSpeechJobIdRef.current,
        speechId,
        text: chunk,
        audioUrl: null,
        provider: "browser" as const,
      }));
      setCallSpeechQueue([...wakeSpeech, ...resumeQueue, ...callSpeechQueueRef.current]);
      playNextCallSpeech();
      return true;
    }
    const generation = callSpeechGenerationRef.current;
    const jobs: Promise<QueuedCallSpeech | null>[] = chunks.map((chunk) => {
      const id = ++callSpeechJobIdRef.current;
      return synthesizeCallTtsAudio(chunk, settings)
        .then((audio): QueuedCallSpeech => ({
          id,
          speechId,
          text: chunk,
          audioUrl: audio.url,
          provider: settings.provider,
        }))
        .catch((err): QueuedCallSpeech | null => {
          if (generation !== callSpeechGenerationRef.current) return null;
          setCallTtsStatus(err instanceof Error ? err.message : "TTS provider failed; using browser voice.");
          return {
            id,
            speechId,
            text: chunk,
            audioUrl: null,
            provider: "browser" as const,
          };
        });
    });
    void Promise.all(jobs).then((wakeSpeech) => {
      if (generation !== callSpeechGenerationRef.current) {
        for (const item of wakeSpeech) {
          if (item?.audioUrl) URL.revokeObjectURL(item.audioUrl);
        }
        return;
      }
      if (wakeSpeech.every((item) => item?.provider === settings.provider)) setCallTtsStatus("");
      setCallSpeechQueue([
        ...wakeSpeech.filter((item): item is QueuedCallSpeech => item !== null),
        ...resumeQueue,
        ...callSpeechQueueRef.current,
      ]);
      playNextCallSpeech();
    });
    return true;
  }

  function flushReadyCallSpeech() {
    const ready: QueuedCallSpeech[] = [];
    while (true) {
      const next = callSpeechReadyByJobIdRef.current.get(callSpeechNextReadyJobIdRef.current);
      if (!next) break;
      callSpeechReadyByJobIdRef.current.delete(callSpeechNextReadyJobIdRef.current);
      callSpeechNextReadyJobIdRef.current += 1;
      ready.push(next);
    }
    if (ready.length === 0) return;
    setCallSpeechQueue([...callSpeechQueueRef.current, ...ready]);
    playNextCallSpeech();
  }

  function enqueueReadyCallSpeech(item: QueuedCallSpeech) {
    callSpeechReadyByJobIdRef.current.set(item.id, item);
    flushReadyCallSpeech();
  }

  function enqueueCallSpeech(
    text: string,
    policy: CallSpeechPolicy = "queue",
  ) {
    const trimmed = normalizeCallSpeechText(text);
    const settings = callTtsSettingsRef.current;
    const chunks = callSpeechChunks(trimmed);
    if (
      chunks.length === 0
      || typeof window === "undefined"
      || (settings.provider === "browser" && (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined"))
    ) {
      return false;
    }
    if (policy === "barge-in-resume") {
      interruptCurrentCallSpeechForVoice({ requeueCurrent: false });
      const resumeQueue = callSpeechQueueRef.current;
      setCallSpeechQueue([]);
      return queueCallSpeechAtFront(trimmed, resumeQueue);
    }
    if (policy === "barge-in") {
      stopCallSpeech();
    }
    const speechId = ++callSpeechMessageIdRef.current;
    const speechGeneration = callSpeechGenerationRef.current;
    if (settings.provider === "browser") {
      for (const chunk of chunks) {
        enqueueReadyCallSpeech({
          id: ++callSpeechJobIdRef.current,
          speechId,
          text: chunk,
          audioUrl: null,
          provider: "browser" as const,
        });
      }
      return true;
    }

    for (const chunk of chunks) {
      const id = ++callSpeechJobIdRef.current;
      void synthesizeCallTtsAudio(chunk, settings)
        .then((audio) => {
          if (speechGeneration !== callSpeechGenerationRef.current) {
            URL.revokeObjectURL(audio.url);
            return;
          }
          setCallTtsStatus("");
          enqueueReadyCallSpeech({
            id,
            speechId,
            text: chunk,
            audioUrl: audio.url,
            provider: settings.provider,
          });
        })
        .catch((err) => {
          if (speechGeneration !== callSpeechGenerationRef.current) return;
          setCallTtsStatus(err instanceof Error ? err.message : "TTS provider failed; using browser voice.");
          enqueueReadyCallSpeech({
            id,
            speechId,
            text: chunk,
            audioUrl: null,
            provider: "browser",
          });
        });
    }
    return true;
  }

  useEffect(() => {
    if (!callMode.isLive) return;
    if (!callSpeechBlockedRef.current) {
      if (!callSpeechSpeakingRef.current && callSpeechQueueRef.current.length > 0) playNextCallSpeech();
      return;
    }
    if (!callSpeechSpeakingRef.current) return;
    interruptCurrentCallSpeechForVoice();
  }, [callMode.isLive, callRecorder.isMuted, callRecorder.isVoiceActive]);

  function queueCallAckSpeechResult(result: CallUtteranceSubmitResult) {
    if (queuedCallAckKeysRef.current.has(result.dispatch.id)) return;
    const sequence = result.utterance.sequence;
    const text = callAckSpeechText(result);
    if (!Number.isFinite(sequence)) {
      if (text) {
        queuedCallAckKeysRef.current.add(result.dispatch.id);
        lastSpokenCallAckRef.current = result.dispatch.id;
        enqueueCallSpeech(text, isWakeOnlyAckResult(result) ? "barge-in-resume" : "queue");
      }
      return;
    }
    if (sequence <= lastQueuedCallAckSequenceRef.current) {
      queuedCallAckKeysRef.current.add(result.dispatch.id);
      if (text) {
        lastSpokenCallAckRef.current = result.dispatch.id;
        enqueueCallSpeech(text, isWakeOnlyAckResult(result) ? "barge-in-resume" : "queue");
      }
      return;
    }
    pendingCallAckSpeechBySequenceRef.current.set(sequence, {
      key: result.dispatch.id,
      text,
    });

    flushPendingCallAckSpeech();
  }

  function flushPendingCallAckSpeech() {
    let nextSequence = lastQueuedCallAckSequenceRef.current + 1;
    while (pendingCallAckSpeechBySequenceRef.current.has(nextSequence)) {
      const next = pendingCallAckSpeechBySequenceRef.current.get(nextSequence);
      pendingCallAckSpeechBySequenceRef.current.delete(nextSequence);
      lastQueuedCallAckSequenceRef.current = nextSequence;
      nextSequence += 1;
      if (!next) continue;
      queuedCallAckKeysRef.current.add(next.key);
      if (next.text) {
        lastSpokenCallAckRef.current = next.key;
        const submitResult = callMode.submitResults.find((result) => result.dispatch.id === next.key);
        enqueueCallSpeech(
          next.text,
          submitResult && isWakeOnlyAckResult(submitResult) ? "barge-in-resume" : "queue",
        );
      }
    }
  }

  useEffect(() => {
    const sessionId = callMode.session?.id ?? null;
    if (sessionId !== callAckSpeechSessionIdRef.current) {
      callAckSpeechSessionIdRef.current = sessionId;
      lastSpokenCallAckRef.current = null;
      lastQueuedCallAckSequenceRef.current = sessionId
        ? latestExistingCallAckSequence(sessionId, callUtterances, callDispatches, Number.POSITIVE_INFINITY)
        : 0;
      queuedCallAckKeysRef.current = new Set(
        sessionId
          ? callDispatches
            .filter((dispatch) => dispatch.session_id === sessionId)
            .map((dispatch) => dispatch.id)
          : [],
      );
      pendingCallAckSpeechBySequenceRef.current.clear();
      spokenCallWorkerMessageIdsRef.current = null;
    }
    if (!sessionId || callMode.isSubmitting || callMode.isResolvingConfirmation) return;

    const queuedCallAckKeys = queuedCallAckKeysRef.current;
    const liveSubmitSequences = callMode.submitResults
      .filter((result) => result.session.id === sessionId && Number.isFinite(result.utterance.sequence))
      .map((result) => result.utterance.sequence);
    const maxHistoricalSequence = liveSubmitSequences.length > 0
      ? Math.min(...liveSubmitSequences)
      : Number.POSITIVE_INFINITY;
    const latestHistoricalSequence = latestExistingCallAckSequence(
      sessionId,
      callUtterances,
      callDispatches,
      maxHistoricalSequence,
    );
    let latestQueuedSequence = latestHistoricalSequence;
    for (const result of callMode.submitResults) {
      if (
        result.session.id === sessionId
        && queuedCallAckKeys.has(result.dispatch.id)
        && Number.isFinite(result.utterance.sequence)
      ) {
        latestQueuedSequence = Math.max(latestQueuedSequence, result.utterance.sequence);
      }
    }
    lastQueuedCallAckSequenceRef.current = latestQueuedSequence;
    queuedCallAckKeysRef.current = new Set(queuedCallAckKeys);
    pendingCallAckSpeechBySequenceRef.current.clear();
  }, [
    callDispatches,
    callMode.isResolvingConfirmation,
    callMode.isSubmitting,
    callMode.session?.id,
    callMode.submitResults,
    callUtterances,
  ]);

  useEffect(() => {
    if (!canPlayCallSpeech) return;
    for (const result of callMode.submitResults) {
      queueCallAckSpeechResult(result);
    }
  }, [canPlayCallSpeech, callMode.submitResults]);

  useEffect(() => {
    const result = callMode.lastResult;
    const ackText = result ? callAckSpeechText(result) : null;
    if (
      !result
      || !canPlayCallSpeech
      || !ackText
      || callMode.submitResults.some((item) => item.dispatch.id === result.dispatch.id)
      || result.dispatch.id === lastSpokenCallAckRef.current
    ) {
      return;
    }
    lastSpokenCallAckRef.current = result.dispatch.id;
    queuedCallAckKeysRef.current.add(result.dispatch.id);
    enqueueCallSpeech(ackText);
  }, [canPlayCallSpeech, callMode.lastResult, callMode.submitResults]);

  useEffect(() => {
    const sessionId = callMode.session?.id ?? null;
    if (!canPlayCallSpeech || !sessionId || callMode.isSubmitting || callMode.isResolvingConfirmation) return;

    const submitDispatchIds = new Set(callMode.submitResults.map((result) => result.dispatch.id));
    const speakableDispatches = callDispatches
      .filter((dispatch) => dispatch.session_id === sessionId)
      .sort((left, right) => {
        const sequenceDelta = left.utterance_sequence - right.utterance_sequence;
        if (sequenceDelta !== 0) return sequenceDelta;
        return new Date(left.updated_at || left.created_at).getTime() - new Date(right.updated_at || right.created_at).getTime();
      });
    for (const dispatch of speakableDispatches) {
      if (queuedCallAckKeysRef.current.has(dispatch.id) || submitDispatchIds.has(dispatch.id)) continue;
      const utterance = callUtterances.find((item) => item.id === dispatch.utterance_id) ?? null;
      if (isRoutineTranscriptionDiagnostic(utterance?.transcription_error)) {
        queuedCallAckKeysRef.current.add(dispatch.id);
        continue;
      }
      const ackText = callDispatchSpeechText(dispatch);
      if (!ackText) continue;
      queuedCallAckKeysRef.current.add(dispatch.id);
      enqueueCallSpeech(ackText, "queue");
    }
  }, [
    callDispatches,
    canPlayCallSpeech,
    callMode.isResolvingConfirmation,
    callMode.isSubmitting,
    callMode.session?.id,
    callMode.submitResults,
    callUtterances,
    messages,
  ]);

  useEffect(() => {
    const sessionId = callMode.session?.id ?? null;
    const workerReplies = callWorkerReplies(sessionId, messages, agentWorkItems);
    const currentSpeechKeys = new Set(workerReplies.map((reply) => reply.speechKey));
    const seenIds = spokenCallWorkerMessageIdsRef.current;
    if (seenIds === null) {
      spokenCallWorkerMessageIdsRef.current = currentSpeechKeys;
      return;
    }
    spokenCallWorkerMessageIdsRef.current = currentSpeechKeys;
    if (!canPlayCallSpeech) return;

    const unspokenWorkerReplies = workerReplies
      .filter((reply) => !seenIds.has(reply.speechKey))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    for (const reply of unspokenWorkerReplies) {
      enqueueCallSpeech(reply.body, "queue");
    }
  }, [agentWorkItems, canPlayCallSpeech, callMode.session?.id, messages]);

  useEffect(() => () => {
    clearCallSpeechGapTimer();
    releaseQueuedCallSpeech(callSpeechQueueRef.current);
    releasePendingCallSpeech();
    callSpeechQueueRef.current = [];
    callSpeechSpeakingRef.current = false;
    stopCurrentCallAudio();
    cancelBrowserCallSpeech();
  }, []);

  useEffect(() => {
    if (!canPlayCallSpeech) stopCallSpeech();
  }, [canPlayCallSpeech]);

  const callControlsBusy = callMode.isStarting || callMode.isStopping || callRecorder.isStopping;
  const callModeLabel = callConsoleModeLabel(effectiveCallConsoleMode);
  const callSettingsSummary = [
    callModeLabel,
    callTtsSettings.provider === "edge" ? "Edge TTS" : "Browser TTS",
    callTtsSettings.language,
    `${callTtsSettings.rate.toFixed(2)}x`,
  ].join(" · ");
  const visibleCallHistorySessions = useMemo(() => {
    const rows = [...surfaceCallSessions];
    if (
      visibleCallSession
      && isVoiceConsoleSession(visibleCallSession)
      && !rows.some((session) => session.id === visibleCallSession.id)
    ) {
      rows.push(visibleCallSession);
    }
    return rows.sort(compareCallSessionsByStart);
  }, [surfaceCallSessions, visibleCallSession]);
  const visibleCallTurns = useMemo(() => {
    return visibleCallHistorySessions
      .flatMap((session) => buildCallTurns(
        session,
        callUtterances,
        callDispatches,
        agentWorkItems,
        agents,
      ))
      .filter((turn) => !isIgnoredNoSpeechTurn(turn))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  }, [agentWorkItems, agents, callDispatches, callUtterances, visibleCallHistorySessions]);

  useEffect(() => {
    if (!visibleCallSession) return;
    setCallDurationNow(Date.now());
    if (visibleCallSession.status !== "active") return;
    const timer = window.setInterval(() => setCallDurationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visibleCallSession]);

  const visibleCallWorkBoardItems = useMemo(() => {
    return buildCallWorkBoardItems(
      visibleCallSession,
      callDispatches,
      agentWorkItems,
      agents,
      callMode.submitResults,
      callUtterances,
    );
  }, [agentWorkItems, agents, callDispatches, callMode.submitResults, callUtterances, visibleCallSession]);
  const visibleLiveCallWorkBoardItems = visibleCallWorkBoardItems.filter((item) => item.isLive).slice(0, 3);
  const liveCallWorkCount = visibleCallWorkBoardItems.filter((item) => item.isLive).length;
  const visibleCallDuration = callDurationMs(visibleCallSession, callDurationNow);
  const visibleCallTtsVoices = voicesForCallTtsProvider(callTtsSettings.provider, callTtsSettings.language);
  const visibleCallThreadRows = useMemo(() => buildCallThreadRows(visibleCallTurns, agents), [agents, visibleCallTurns]);
  const activeCallThread = useMemo<CallThreadRow | null>(() => {
    if (!activeCallThreadId) return null;
    return visibleCallThreadRows.find((thread) => thread.id === activeCallThreadId) ?? null;
  }, [activeCallThreadId, visibleCallThreadRows]);

  function handleCallMessageListScroll() {
    const element = callMessageListRef.current;
    if (!element || element.scrollTop >= 96 || olderCallHistoryLoadInFlightRef.current || allOlderCallHistoryLoadedRef.current) {
      return;
    }
    olderCallHistoryLoadInFlightRef.current = true;
    const previousScrollHeight = element.scrollHeight;
    void loadOlderCallHistory()
      .then((loadedCount) => {
        if (loadedCount === 0) allOlderCallHistoryLoadedRef.current = true;
      })
      .finally(() => {
        window.requestAnimationFrame(() => {
          const list = callMessageListRef.current;
          if (list) list.scrollTop += list.scrollHeight - previousScrollHeight;
          olderCallHistoryLoadInFlightRef.current = false;
        });
      });
  }

  const pendingCallConfirmation = useMemo<PendingCallConfirmation | null>(() => {
    const confirmationRows = buildCallConfirmationRows(
      visibleCallSession,
      callUtterances,
      callDispatches,
      callMode.submitResults,
    );
    let hasNewerNonIgnoredUtterance = false;
    for (const row of [...confirmationRows].reverse()) {
      const dispatch = row.dispatch;
      if (isPendingConfirmationDispatch(dispatch)) {
        if (hasNewerNonIgnoredUtterance) return null;
        const target = dispatch.target_agent_id
          ? agents.find((agent) => agent.id === dispatch.target_agent_id) ?? null
          : null;
        return {
          dispatch,
          utterance: row.utterance,
          targetLabel: target ? `@${target.handle}` : "unresolved target",
        };
      }
      if (row.utterance.status !== "ignored") {
        hasNewerNonIgnoredUtterance = true;
      }
    }
    return null;
  }, [agents, callDispatches, callMode.submitResults, callUtterances, visibleCallSession]);

  useEffect(() => {
    setCallConfirmationCorrectionDraft("");
  }, [pendingCallConfirmation?.dispatch.id]);

  useEffect(() => {
    setCallThreadReplyDraft("");
  }, [activeCallThreadId]);

  useEffect(() => {
    if (visibleCallThreadRows.length === 0) {
      if (activeCallThreadId !== null) setActiveCallThreadId(null);
      return;
    }
    if (activeCallThreadId && !visibleCallThreadRows.some((thread) => thread.id === activeCallThreadId)) {
      setActiveCallThreadId(null);
    }
  }, [activeCallThreadId, setActiveCallThreadId, visibleCallThreadRows]);

  async function startCallMode() {
    if (callControlsBusy) return;
    await callMode.start();
  }

  async function endCallMode() {
    if (!callMode.isLive || callControlsBusy) return;
    const sessionId = callMode.session?.id ?? null;
    finalCallSpeechDrainSessionIdRef.current = sessionId;
    setFinalCallSpeechDrainSessionId(sessionId);
    stopCallSpeech({ preserveFinalDrain: true });
    await callRecorder.flushAndStop();
    await callMode.stop();
  }

  async function cancelCallWork(workItemId: string) {
    if (!callMode.isLive || callMode.isControllingWork) return;
    await callMode.cancelWork(workItemId);
  }

  async function resolveCallConfirmation(transcript: string) {
    if (!callMode.isLive || callMode.isResolvingConfirmation) return;
    await callMode.resolveConfirmation(transcript);
  }

  async function correctCallConfirmation() {
    const cleanDraft = callConfirmationCorrectionDraft.trim();
    if (!cleanDraft) return;
    await resolveCallConfirmation(cleanDraft);
  }

  async function submitTypedCallUtterance() {
    const transcript = callTypedUtteranceDraft.trim();
    if (!callMode.isLive || isSubmittingTypedCallUtterance || !transcript) return;
    setIsSubmittingTypedCallUtterance(true);
    try {
      await callMode.submitTypedUtterance({ transcript });
      setCallTypedUtteranceDraft("");
    } finally {
      setIsSubmittingTypedCallUtterance(false);
    }
  }

  async function submitCallThreadReply() {
    const transcript = callThreadReplyDraft.trim();
    if (!activeCallThread || !callMode.isLive || isSubmittingCallThreadReply || !transcript) return;
    setIsSubmittingCallThreadReply(true);
    try {
      await callMode.submitTypedUtterance({
        transcript,
        threadRootUtteranceId: activeCallThread.id,
      });
      setActiveCallThreadId(activeCallThread.id);
      setCallThreadReplyDraft("");
    } finally {
      setIsSubmittingCallThreadReply(false);
    }
  }

  function submitCallTextOnEnter(
    event: KeyboardEvent<HTMLTextAreaElement>,
    submit: () => void,
  ) {
    if (
      event.key !== "Enter"
      || event.shiftKey
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  }

  function callRecorderStatusState() {
    if (!callRecorder.isSupported) return "denied";
    if (callRecorder.status === "requesting" || callRecorder.isStopping || callRecorder.isSubmittingAudio) return "requesting";
    if (callRecorder.status === "error") return "denied";
    if (callRecorder.status === "listening") return "granted";
    return "unknown";
  }

  function callRecorderStatusText() {
    if (!callRecorder.isSupported) return "Capture unavailable";
    if (callRecorder.isStopping) return "Sending final audio";
    if (callRecorder.status === "requesting") return "Requesting mic";
    if (callRecorder.status === "muted") return "Mic muted";
    if (callRecorder.status === "listening" && callRecorder.isSubmittingAudio) return "Listening + sending";
    if (callRecorder.status === "listening") return "Listening";
    if (callRecorder.status === "error") return "Capture blocked";
    return "Mic ready";
  }

  function toggleCallMute() {
    if (!callMode.isLive || callRecorder.isStopping || callRecorder.isRequestingPermission || !callRecorder.isSupported) return;
    if (callRecorder.isMuted) callRecorder.unmute();
    else callRecorder.mute();
  }

  function updateCallConsoleMode(mode: VoiceConsoleMode) {
    if (callMode.isLive) return;
    setCallWakeSettings({
      ...callWakeSettings,
      mode,
    });
  }

  function updateCallWakeWords(wakeWords: string) {
    setCallWakeSettings({
      ...callWakeSettings,
      wakeWords,
    });
  }

  function updateCallTtsProvider(provider: CallTtsProviderId) {
    const voices = voicesForCallTtsProvider(provider, callTtsSettings.language);
    setCallTtsSettings({
      ...callTtsSettings,
      provider,
      voice: voices[0]?.id ?? callTtsSettings.voice,
    });
  }

  function updateCallVoiceLanguage(language: CallVoiceLanguage) {
    const voices = voicesForCallTtsProvider(callTtsSettings.provider, language);
    setCallTtsSettings({
      ...callTtsSettings,
      language,
      voice: voices[0]?.id ?? callTtsSettings.voice,
    });
  }

  function updateCallTtsVoice(voice: string) {
    const voiceConfig = CALL_TTS_VOICES.find((item) => item.id === voice);
    setCallTtsSettings({
      ...callTtsSettings,
      provider: voiceConfig?.provider ?? callTtsSettings.provider,
      voice,
    });
  }

  function updateCallTtsRate(delta: number) {
    setCallTtsSettings({
      ...callTtsSettings,
      rate: Math.round((callTtsSettings.rate + delta) * 100) / 100,
    });
  }

  function renderCallAvatar(row: CallMessageRow) {
    if (row.senderRole === "owner") {
      return <AgentAvatar agent={ownerAsAvatarAgent(ownerProfile)} size="md" showStatus={false} />;
    }
    if (row.senderAgent) {
      return <AgentAvatar agent={row.senderAgent} size="md" />;
    }
    if (row.senderName === "System Agent") {
      return <AgentAvatar agent={callSystemAvatarAgent} size="md" showStatus={false} />;
    }
    return <div className="avatar">{row.senderName.replace(/^@/, "").slice(0, 1).toUpperCase() || "S"}</div>;
  }

  return (
    <>
    <section className="conversation call-console-page" aria-label="Voice">
      <header className="topbar">
        <button
          type="button"
          className="mobile-nav-button"
          aria-label="Back to navigation"
          onClick={openMobileSidebar}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="channel-title">
          <span className="hash-card call-console-icon">
            <Phone />
          </span>
          <div>
            <h1>Voice</h1>
            <p>Call Console</p>
          </div>
        </div>
        <div className="call-header-actions">
          <button
            type="button"
            className={`call-header-button call-header-settings ${showCallSettings ? "active" : ""}`}
            title="Voice settings"
            aria-label="Voice settings"
            aria-expanded={showCallSettings}
            onClick={() => setShowCallSettings((open) => !open)}
          >
            <Settings size={17} />
            <span className="call-header-label">Settings</span>
          </button>
          <button
            type="button"
            className={`call-header-button ${callMode.isLive ? "live" : ""}`}
            title={callMode.isLive ? `End ${callModeLabel} Mode` : `Start ${callModeLabel} Mode`}
            aria-label={callMode.isLive ? `End ${callModeLabel} Mode` : `Start ${callModeLabel} Mode`}
            aria-pressed={callMode.isLive}
            disabled={callControlsBusy}
            onClick={() => {
              if (callControlsBusy) return;
              if (callMode.isLive) void endCallMode();
              else void startCallMode();
            }}
          >
            {callMode.isLive ? <PhoneOff size={17} /> : <Phone size={17} />}
            <span className="call-header-label">{callMode.isLive ? `End ${callModeLabel}` : `Start ${callModeLabel}`}</span>
          </button>
          <button
            type="button"
            className={`call-header-button call-header-mic ${callRecorder.isMuted ? "muted" : ""}`}
            title={callRecorder.isMuted ? "Unmute microphone" : "Mute microphone"}
            aria-label={callRecorder.isMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={callRecorder.isMuted}
            disabled={!callMode.isLive || callRecorder.isStopping || callRecorder.isRequestingPermission || !callRecorder.isSupported}
            onClick={toggleCallMute}
          >
            {callRecorder.isMuted ? <MicOff size={17} /> : <Mic size={17} />}
            <span className="call-header-label">{callRecorder.isMuted ? "Muted" : "Mic"}</span>
          </button>
        </div>
      </header>
      {showCallSettings && (
        <aside className="call-settings-panel" aria-label="Voice settings panel">
          <div className="call-settings-panel-header">
            <div>
              <strong>Voice settings</strong>
              <span>{callSettingsSummary}</span>
            </div>
            <button type="button" aria-label="Close voice settings" onClick={() => setShowCallSettings(false)}>
              <X size={15} />
            </button>
          </div>
          <div className="call-settings-grid">
            <div className="call-tts-card call-tts-provider-card">
              <span><Sparkles size={13} /> Mode</span>
              <div className="call-tts-segmented" role="group" aria-label="Call console mode">
                <button
                  type="button"
                  className={effectiveCallConsoleMode === "call" ? "active" : ""}
                  aria-pressed={effectiveCallConsoleMode === "call"}
                  disabled={callMode.isLive}
                  onClick={() => updateCallConsoleMode("call")}
                >
                  <Phone size={13} />
                  Call
                </button>
                <button
                  type="button"
                  className={effectiveCallConsoleMode === "wake_word" ? "active" : ""}
                  aria-pressed={effectiveCallConsoleMode === "wake_word"}
                  disabled={callMode.isLive}
                  onClick={() => updateCallConsoleMode("wake_word")}
                >
                  <Mic size={13} />
                  Wake Word
                </button>
              </div>
            </div>
            <label className="call-tts-card call-wake-word-card">
              <span><Mic size={13} /> Wake words</span>
              <input
                type="text"
                value={callWakeSettings.wakeWords}
                disabled={callMode.isLive || effectiveCallConsoleMode !== "wake_word"}
                onChange={(event) => updateCallWakeWords(event.currentTarget.value)}
                placeholder="兰托, 蓝托, Lantor"
                aria-label="Call wake words"
              />
            </label>
            <div className="call-tts-card call-tts-provider-card">
              <span><MonitorSpeaker size={13} /> Provider</span>
              <div className="call-tts-segmented" role="group" aria-label="Call voice provider">
                <button
                  type="button"
                  className={callTtsSettings.provider === "browser" ? "active" : ""}
                  aria-pressed={callTtsSettings.provider === "browser"}
                  onClick={() => updateCallTtsProvider("browser")}
                >
                  <Laptop size={13} />
                  Browser
                </button>
                <button
                  type="button"
                  className={callTtsSettings.provider === "edge" ? "active" : ""}
                  aria-pressed={callTtsSettings.provider === "edge"}
                  onClick={() => updateCallTtsProvider("edge")}
                >
                  <Sparkles size={13} />
                  Edge
                </button>
              </div>
            </div>
            <div className="call-tts-card call-tts-language-card">
              <span><Sparkles size={13} /> Language</span>
              <div className="call-tts-segmented" role="group" aria-label="Call spoken language">
                {CALL_VOICE_LANGUAGES.map((language) => (
                  <button
                    key={language.id}
                    type="button"
                    className={language.id === callTtsSettings.language ? "active" : ""}
                    aria-pressed={language.id === callTtsSettings.language}
                    onClick={() => updateCallVoiceLanguage(language.id)}
                  >
                    {language.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="call-tts-card call-tts-voice-card">
              <span><Sparkles size={13} /> Voice</span>
              <div className="call-tts-chip-row" role="group" aria-label="Call voice">
                {visibleCallTtsVoices.map((voice) => (
                  <button
                    key={voice.id}
                    type="button"
                    className={voice.id === callTtsSettings.voice ? "active" : ""}
                    aria-pressed={voice.id === callTtsSettings.voice}
                    onClick={() => updateCallTtsVoice(voice.id)}
                  >
                    {voice.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="call-tts-card call-tts-speed-card">
              <span><Gauge size={13} /> Speed</span>
              <div className="call-tts-stepper">
                <button
                  type="button"
                  aria-label="Decrease call voice speed"
                  disabled={callTtsSettings.rate <= 0.5}
                  onClick={() => updateCallTtsRate(-0.05)}
                >
                  -
                </button>
                <strong>{callTtsSettings.rate.toFixed(2)}x</strong>
                <button
                  type="button"
                  aria-label="Increase call voice speed"
                  disabled={callTtsSettings.rate >= 2}
                  onClick={() => updateCallTtsRate(0.05)}
                >
                  +
                </button>
              </div>
            </div>
          </div>
          {callTtsStatus && <small>{callTtsStatus}</small>}
        </aside>
      )}

      <div ref={callMessageListRef} className="message-list" onScroll={handleCallMessageListScroll}>
        <div className="message-list-content">
          {visibleCallThreadRows.length > 0 ? (
            <div className="beginning">Beginning of Voice</div>
          ) : (
            <div className="empty-state">
              <Phone size={34} />
              <h2>No voice messages yet</h2>
              <p>Start Call, then speak or type to create the first Voice message.</p>
            </div>
          )}
          {(callMode.isLive || visibleCallSession || callMode.error || callMode.lastResult) && (
            <section className={`call-mode-panel ${callMode.isLive ? "live" : ""}`} aria-label="Call Mode status">
              <div className="call-mode-status">
                <span className="call-mode-live-dot" aria-hidden="true" />
                <div>
                  <strong>{callMode.isLive ? `${callModeLabel} Console live` : `${callModeLabel} Console ended`}</strong>
                  <span>{callModeStatusText(callMode.error, callMode.lastResult, visibleCallSession)}</span>
                </div>
                <mark
                  className="call-mode-provider-status"
                  data-state={callRecorderStatusState()}
                  title={callRecorder.error ?? (callRecorder.statusMessage || "Browser mic to backend STT")}
                >
                  {callRecorderStatusText()}
                </mark>
              </div>
              <div className="call-mode-cockpit" role="group" aria-label="Live call cockpit">
                <div className="call-mode-cockpit-item">
                  <Clock size={14} />
                  <span>Duration</span>
                  <strong>{visibleCallDuration === null ? "--:--" : formatCallDuration(visibleCallDuration)}</strong>
                </div>
                <div className="call-mode-cockpit-item">
                  {callRecorder.isMuted ? <MicOff size={14} /> : <Mic size={14} />}
                  <span>Mic</span>
                  <strong>{callRecorderStatusText()}</strong>
                  <div
                    className="call-mode-activity-meter"
                    data-state={callRecorder.isListening && !callRecorder.isMuted ? "active" : "idle"}
                    aria-label={callRecorder.isListening && !callRecorder.isMuted ? "Listening activity" : "Mic idle activity"}
                  >
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
              {callTtsStatus && <small className="call-mode-status-error">{callTtsStatus}</small>}
              {visibleLiveCallWorkBoardItems.length > 0 && (
                <details className="call-mode-work-board" open>
                  <summary className="call-mode-work-board-header">
                    <strong><BriefcaseBusiness size={15} /> Active work</strong>
                    <span>
                      {liveCallWorkCount > visibleLiveCallWorkBoardItems.length
                        ? `${visibleLiveCallWorkBoardItems.length}/${liveCallWorkCount} shown`
                        : `${liveCallWorkCount} live`}
                    </span>
                  </summary>
                  <div className="call-mode-work-board-list">
                    {visibleLiveCallWorkBoardItems.map((item) => (
                      <article key={item.id} data-tone={item.tone}>
                        <div className="call-mode-work-row">
                          <button
                            type="button"
                            className="call-mode-work-open"
                            disabled={!item.workItem}
                            onClick={() => {
                              if (item.workItem) onOpenWorkItem(item.workItem);
                            }}
                          >
                            <span className="call-mode-work-sequence">
                              {item.requestNumber ? `Request ${item.requestNumber}` : "Call"}
                            </span>
                            <span className="call-mode-work-body">
                              <strong>{item.title}</strong>
                              <small>
                                {item.agentHandle ? `@${item.agentHandle}` : "Dispatcher"} - {item.statusText}
                              </small>
                            </span>
                            <mark>{callWorkBoardStatusLabel(item)}</mark>
                          </button>
                          {item.workItem && item.isLive && (
                            <button
                              type="button"
                              className="call-mode-work-cancel"
                              title="Cancel call request"
                              aria-label={`Cancel call request ${item.requestNumber ? `number ${item.requestNumber}` : item.workItem.title}`}
                              disabled={!callMode.isLive || callMode.isControllingWork}
                              onClick={() => {
                                if (item.workItem) void cancelCallWork(item.workItem.id);
                              }}
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              )}
            </section>
          )}
          {visibleCallThreadRows.map((thread, index) => {
            const showDateDivider = index === 0 || !isSameCalendarDay(thread.createdAt, visibleCallThreadRows[index - 1]?.createdAt ?? "");
            return (
              <div key={thread.id}>
                {showDateDivider && (
                  <div className="message-date-divider" role="separator">
                    <span />
                    <time dateTime={thread.createdAt}>{formatDateDivider(thread.createdAt)}</time>
                    <span />
                  </div>
                )}
                <article
                  className={`message-card ${activeCallThread?.id === thread.id ? "focused" : ""}`}
                  data-sender-role="owner"
                  data-tone={thread.root.tone}
                  onClick={() => setActiveCallThreadId(thread.id)}
                >
                  <div>
                    {renderCallAvatar(thread.root)}
                  </div>
                  <div className="message-body">
                    <div className="meta">
                      <strong>{ownerProfile.display_name}</strong>
                      <span>{thread.root.senderMeta}</span>
                      <time>{formatTime(thread.root.createdAt)}</time>
                    </div>
                    <MessageMarkdown body={thread.root.body} />
                    {thread.replies.length > 0 && (
                      <button
                        type="button"
                        className={`thread-reply-summary ${activeCallThread?.id === thread.id ? "active-reply" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveCallThreadId(thread.id);
                        }}
                      >
                        <strong>{thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}</strong>
                        <span className="thread-reply-summary-action">
                          <time>{formatTime(thread.replies[thread.replies.length - 1].createdAt)}</time>
                          <span className="thread-reply-summary-open">Open</span>
                        </span>
                      </button>
                    )}
                  </div>
                </article>
              </div>
            );
          })}
          {pendingCallConfirmation && !activeCallThread && (
            <article className="message-card call-confirmation-message" data-sender-role="agent">
              <AgentAvatar agent={callSystemAvatarAgent} size="md" showStatus={false} />
              <div className="message-body">
                <div className="meta">
                  <strong>System Agent</strong>
                  <span>Pending call confirmation</span>
                  <time>{formatTime(pendingCallConfirmation.dispatch.updated_at || pendingCallConfirmation.dispatch.created_at)}</time>
                </div>
                <MessageMarkdown
                  body={[
                    "Confirm before assigning",
                    pendingCallConfirmation.dispatch.ack_text || "Confirm before assigning this voice request.",
                    `Target: ${pendingCallConfirmation.targetLabel}`,
                    `Request: ${pendingCallConfirmation.utterance.transcript || "No transcript"}`,
                  ].join("\n\n")}
                />
                <div className="call-mode-confirmation-actions" aria-label="Confirmation actions">
                  <button
                    type="button"
                    className="confirm"
                    disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                    aria-label={`Confirm call request number ${pendingCallConfirmation.utterance.sequence}`}
                    onClick={() => void resolveCallConfirmation("yes")}
                  >
                    <CheckCircle2 size={13} />
                    <span>Confirm</span>
                  </button>
                  <button
                    type="button"
                    className="reject"
                    disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                    aria-label={`Reject call request number ${pendingCallConfirmation.utterance.sequence}`}
                    onClick={() => void resolveCallConfirmation("no")}
                  >
                    <X size={13} />
                    <span>Reject</span>
                  </button>
                  <form
                    className="call-mode-confirmation-correct"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void correctCallConfirmation();
                    }}
                  >
                    <input
                      value={callConfirmationCorrectionDraft}
                      onChange={(event) => setCallConfirmationCorrectionDraft(event.currentTarget.value)}
                      placeholder="@agent or corrected target"
                      aria-label={`Correct call request number ${pendingCallConfirmation.utterance.sequence}`}
                      disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                    />
                    <button
                      type="submit"
                      className="correct"
                      disabled={!callMode.isLive || callMode.isResolvingConfirmation || !callConfirmationCorrectionDraft.trim()}
                      aria-label={`Submit correction for call request number ${pendingCallConfirmation.utterance.sequence}`}
                    >
                      <RotateCcw size={13} />
                      <span>Correct</span>
                    </button>
                  </form>
                </div>
              </div>
            </article>
          )}
        </div>
      </div>
      <form
        className="composer call-mode-typed-utterance"
        onSubmit={(event) => {
          event.preventDefault();
          void submitTypedCallUtterance();
        }}
      >
        {callMode.isLive && (callRecorder.statusMessage || callRecorder.error) && (
          <div className={`voice-input-status ${callRecorder.error ? "error" : ""}`}>
            {callRecorder.error || callRecorder.statusMessage}
          </div>
        )}
        <textarea
          value={callTypedUtteranceDraft}
          onChange={(event) => setCallTypedUtteranceDraft(event.currentTarget.value)}
          onKeyDown={(event) => submitCallTextOnEnter(event, () => void submitTypedCallUtterance())}
          placeholder={callMode.isLive ? "Message Voice" : "Start Call to message Voice"}
          aria-label="Type to simulate Call Mode speech"
          disabled={!callMode.isLive}
        />
        <div className="composer-actions">
          <button
            className="send"
            title="Send Voice message"
            aria-label="Submit typed Call Mode speech"
            disabled={!callMode.isLive || isSubmittingTypedCallUtterance || !callTypedUtteranceDraft.trim()}
          >
            <Send size={17} />
          </button>
        </div>
      </form>
    </section>
    {activeCallThread && (
    <aside className="thread call-console-thread" aria-label="Voice thread">
      <header>
        <button
          type="button"
          className="thread-mobile-back"
          onClick={() => setActiveCallThreadId(null)}
          aria-label="Back to Voice"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="thread-title">
          <span className="hash-card thread-title-card" aria-hidden="true">
            <Phone size={21} />
          </span>
          <h2>
            Thread <span>- Voice #{activeCallThread.sequence}</span>
          </h2>
        </div>
        <button type="button" className="thread-close" onClick={() => setActiveCallThreadId(null)} aria-label="Close voice thread"><X size={18} /></button>
      </header>
      <section className="thread-focus">
        <div className="thread-scroll">
          <>
              <div className="message-date-divider" role="separator">
                <span />
                <time dateTime={activeCallThread.createdAt}>{formatDateDivider(activeCallThread.createdAt)}</time>
                <span />
              </div>
              <article className="thread-root" data-sender-role="owner" data-tone={activeCallThread.root.tone}>
                <div className="thread-message-with-avatar">
                  {renderCallAvatar(activeCallThread.root)}
                  <div className="thread-message-content">
                    <div className="meta">
                      <strong>{ownerProfile.display_name}</strong>
                      <span>{activeCallThread.root.senderMeta}</span>
                      <time>{formatTime(activeCallThread.root.createdAt)}</time>
                    </div>
                    <MessageMarkdown body={activeCallThread.root.body} />
                  </div>
                </div>
              </article>
              <div className="thread-replies-divider" aria-label="Beginning of replies">
                <span />
                <div>
                  <strong>Beginning of replies</strong>
                  <small>{activeCallThread.replies.length} {activeCallThread.replies.length === 1 ? "reply" : "replies"}</small>
                </div>
                <span />
              </div>
              <section className="reply-list">
                {activeCallThread.replies.map((reply) => {
                  if (reply.senderRole === "system") {
                    return (
                      <article key={reply.id} className="system-message" data-tone={reply.tone}>
                        <div className="system-message-line">
                          <MessageMarkdown body={reply.body} />
                          <time>{formatTime(reply.createdAt)}</time>
                        </div>
                      </article>
                    );
                  }
                  return (
                    <article key={reply.id} data-sender-role={reply.senderRole} data-tone={reply.tone}>
                      {renderCallAvatar(reply)}
                      <div className="reply-body">
                        <div className="meta">
                          <strong>{reply.senderName}</strong>
                          <span>{reply.senderMeta}</span>
                          <time>{formatTime(reply.createdAt)}</time>
                        </div>
                        <MessageMarkdown body={reply.body} />
                      </div>
                    </article>
                  );
                })}
                {pendingCallConfirmation && (pendingCallConfirmation.utterance.thread_root_utterance_id ?? pendingCallConfirmation.utterance.id) === activeCallThread.id && (
                  <article className="call-confirmation-message" data-sender-role="agent">
                    <AgentAvatar agent={callSystemAvatarAgent} size="md" showStatus={false} />
                    <div className="thread-message-content">
                      <div className="meta">
                        <strong>System Agent</strong>
                        <span>Pending call confirmation</span>
                        <time>{formatTime(pendingCallConfirmation.dispatch.updated_at || pendingCallConfirmation.dispatch.created_at)}</time>
                      </div>
                      <MessageMarkdown
                        body={[
                          "Confirm before assigning",
                          pendingCallConfirmation.dispatch.ack_text || "Confirm before assigning this voice request.",
                          `Target: ${pendingCallConfirmation.targetLabel}`,
                          `Request: ${pendingCallConfirmation.utterance.transcript || "No transcript"}`,
                        ].join("\n\n")}
                      />
                      <div className="call-mode-confirmation-actions" aria-label="Confirmation actions">
                        <button
                          type="button"
                          className="confirm"
                          disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                          aria-label={`Confirm call request number ${pendingCallConfirmation.utterance.sequence}`}
                          onClick={() => void resolveCallConfirmation("yes")}
                        >
                          <CheckCircle2 size={13} />
                          <span>Confirm</span>
                        </button>
                        <button
                          type="button"
                          className="reject"
                          disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                          aria-label={`Reject call request number ${pendingCallConfirmation.utterance.sequence}`}
                          onClick={() => void resolveCallConfirmation("no")}
                        >
                          <X size={13} />
                          <span>Reject</span>
                        </button>
                        <form
                          className="call-mode-confirmation-correct"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void correctCallConfirmation();
                          }}
                        >
                          <input
                            value={callConfirmationCorrectionDraft}
                            onChange={(event) => setCallConfirmationCorrectionDraft(event.currentTarget.value)}
                            placeholder="@agent or corrected target"
                            aria-label={`Correct call request number ${pendingCallConfirmation.utterance.sequence}`}
                            disabled={!callMode.isLive || callMode.isResolvingConfirmation}
                          />
                          <button
                            type="submit"
                            className="correct"
                            disabled={!callMode.isLive || callMode.isResolvingConfirmation || !callConfirmationCorrectionDraft.trim()}
                            aria-label={`Submit correction for call request number ${pendingCallConfirmation.utterance.sequence}`}
                          >
                            <RotateCcw size={13} />
                            <span>Correct</span>
                          </button>
                        </form>
                      </div>
                    </div>
                  </article>
                )}
              </section>
          </>
          <div className="thread-bottom-anchor" aria-hidden="true" />
        </div>
        <form
          className="reply-composer call-thread-reply-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCallThreadReply();
          }}
        >
          <textarea
            value={callThreadReplyDraft}
            onChange={(event) => setCallThreadReplyDraft(event.currentTarget.value)}
            onKeyDown={(event) => submitCallTextOnEnter(event, () => void submitCallThreadReply())}
            placeholder={callMode.isLive ? "Reply in Voice thread" : "Start Call to reply"}
            aria-label={`Reply to Voice thread ${activeCallThread.sequence}`}
            disabled={!callMode.isLive}
          />
          <div className="composer-actions">
            <button
              className="reply-send"
              title="Send Voice thread reply"
              aria-label={`Submit reply to Voice thread ${activeCallThread.sequence}`}
              disabled={!callMode.isLive || isSubmittingCallThreadReply || !callThreadReplyDraft.trim()}
            >
              <Send size={17} />
            </button>
          </div>
        </form>
      </section>
    </aside>
    )}
    </>
  );
}
