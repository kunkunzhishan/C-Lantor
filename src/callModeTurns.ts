import type { Agent, AgentWorkItem, CallDispatch, CallSession, CallUtterance } from "./types";

export type CallTurnEventTone = "neutral" | "pending" | "active" | "done" | "attention";

export type CallTurnEvent = {
  id: string;
  label: string;
  title: string;
  detail: string;
  tone: CallTurnEventTone;
  timestamp: string;
};

export type CallTurn = {
  id: string;
  sequence: number;
  transcript: string;
  transcriptionError: string;
  audioDurationMs: number | null;
  status: string;
  createdAt: string;
  events: CallTurnEvent[];
};

const ACTIVE_WORK_STATUSES = new Set(["queued", "running", "cancelling"]);
const ATTENTION_STATUSES = new Set(["failed", "cancelled", "compensated"]);

export function buildCallTurns(
  session: CallSession | null,
  callUtterances: CallUtterance[],
  callDispatches: CallDispatch[],
  agentWorkItems: AgentWorkItem[],
  agents: Agent[],
): CallTurn[] {
  if (!session) return [];

  const agentHandleById = new Map(agents.map((agent) => [agent.id, agent.handle]));
  const utterances = callUtterances
    .filter((utterance) => utterance.session_id === session.id && isVisibleCallUtterance(utterance))
    .sort((left, right) => left.sequence - right.sequence);
  const dispatchesByUtterance = groupBy(callDispatches.filter((dispatch) => dispatch.session_id === session.id), (dispatch) => dispatch.utterance_id);
  const workItemsByUtterance = groupBy(agentWorkItems.filter((item) => item.call_session_id === session.id), (item) => item.call_utterance_id ?? "");
  const utterancesByThreadRoot = groupBy(utterances, (utterance) => utterance.thread_root_utterance_id ?? utterance.id);
  const roots = utterances
    .filter((utterance) => (utterance.thread_root_utterance_id ?? utterance.id) === utterance.id)
    .filter((utterance) => utterancesByThreadRoot.has(utterance.id));

  return roots.map((rootUtterance) => {
    const threadUtterances = (utterancesByThreadRoot.get(rootUtterance.id) ?? [rootUtterance])
      .sort((left, right) => left.sequence - right.sequence);
    const events: CallTurnEvent[] = threadUtterances.flatMap((utterance) => {
      const dispatches = (dispatchesByUtterance.get(utterance.id) ?? [])
        .filter((dispatch) => !(dispatch.intent === "coordinator_pending" && dispatch.status === "superseded"))
        .filter((dispatch) => dispatch.intent !== "worker_feedback")
        .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
      const workItems = (workItemsByUtterance.get(utterance.id) ?? [])
        .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
      return [
        {
          id: `user:${utterance.id}`,
          label: "User",
          title: utterance.transcript || "No transcript",
          detail: utterance.transcription_error || utterance.status,
          tone: toneForUtterance(utterance),
          timestamp: utterance.created_at,
        },
        ...dispatches.map((dispatch) => {
          const targetAgentHandle = dispatch.target_agent_id ? agentHandleById.get(dispatch.target_agent_id) ?? null : null;
          const detail = dispatch.ack_text || dispatch.error || dispatch.status_text || dispatch.status;
          return {
            id: `dispatch:${dispatch.id}`,
            label: targetAgentHandle ? `System -> @${targetAgentHandle}` : "System",
            title: dispatchLabel(dispatch),
            detail,
            tone: toneForDispatch(dispatch),
            timestamp: dispatch.updated_at || dispatch.created_at,
          };
        }),
        ...workItems.flatMap((workItem) => {
          const workEvents: CallTurnEvent[] = [{
            id: `work:${workItem.id}`,
            label: workItem.agent_handle ? `@${workItem.agent_handle}` : "Worker",
            title: workItem.title || "Worker task",
            detail: workItem.result_body?.trim() || workStatusText(workItem.status),
            tone: toneForWorkItem(workItem),
            timestamp: workItem.updated_at || workItem.created_at,
          }];
          return workEvents;
        }),
      ];
    })
      .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());

    return {
      id: rootUtterance.id,
      sequence: rootUtterance.sequence,
      transcript: rootUtterance.transcript,
      transcriptionError: rootUtterance.transcription_error,
      audioDurationMs: rootUtterance.audio_duration_ms,
      status: callTurnStatusForThread(threadUtterances, dispatchesByUtterance, workItemsByUtterance),
      createdAt: rootUtterance.created_at,
      events,
    };
  });
}

function isVisibleCallUtterance(utterance: CallUtterance) {
  if (isRoutineIgnoredDiagnostic(utterance.transcription_error)) {
    return false;
  }
  if (utterance.status !== "ignored") return true;
  return Boolean(
    utterance.transcription_error
      && (utterance.audio_duration_ms ?? 0) > 5_000
      && !isRoutineIgnoredDiagnostic(utterance.transcription_error),
  );
}

function isRoutineIgnoredDiagnostic(value: string | null | undefined) {
  const lower = (value ?? "").toLowerCase();
  return lower.includes("no speech")
    || lower.includes("speech was not detected")
    || lower.includes("emptytranscript")
    || lower.includes("wake word required")
    || lower.includes("waiting for the wake word")
    || lower.includes("等待唤醒词");
}

function groupBy<T>(items: T[], keyForItem: (item: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    if (!key) continue;
    const current = grouped.get(key) ?? [];
    current.push(item);
    grouped.set(key, current);
  }
  return grouped;
}

function dispatchLabel(dispatch: CallDispatch) {
  if (dispatch.intent === "coordinator_pending") {
    if (dispatch.status === "dispatching") return "Dispatcher running";
    if (dispatch.status === "queued") return "Queued for dispatcher";
    return "Dispatcher queue";
  }
  if (dispatch.intent === "agent_work") return "Dispatch decision";
  if (dispatch.intent === "cancel_work") return "Cancel decision";
  if (dispatch.intent === "clarify") return "Clarification";
  return "System reply";
}

function toneForUtterance(utterance: CallUtterance): CallTurnEventTone {
  if (utterance.status === "queued") return "pending";
  if (utterance.status === "dispatching" || utterance.status === "transcribing") return "active";
  if (utterance.status === "failed") return "attention";
  return "neutral";
}

function toneForDispatch(dispatch: CallDispatch): CallTurnEventTone {
  if (dispatch.status === "queued") return "pending";
  if (dispatch.status === "dispatching") return "active";
  if (ATTENTION_STATUSES.has(dispatch.status)) return "attention";
  if (dispatch.status === "needs_user") return "attention";
  if (dispatch.status === "acknowledged" || dispatch.status === "superseded") return "done";
  return "neutral";
}

function toneForWorkItem(workItem: AgentWorkItem): CallTurnEventTone {
  if (ACTIVE_WORK_STATUSES.has(workItem.status)) return "active";
  if (ATTENTION_STATUSES.has(workItem.status)) return "attention";
  if (workItem.status === "done") return "done";
  return "pending";
}

function workStatusText(status: string) {
  if (status === "queued") return "Queued for worker pickup";
  if (status === "running") return "Worker is running";
  if (status === "cancelling") return "Cancellation requested";
  if (status === "done") return "Worker finished";
  if (status === "failed") return "Worker failed";
  if (status === "cancelled") return "Worker cancelled";
  return status.replace(/_/g, " ");
}

function callTurnStatus(
  utterance: CallUtterance,
  dispatches: CallDispatch[],
  workItems: AgentWorkItem[],
) {
  if (workItems.some((item) => ACTIVE_WORK_STATUSES.has(item.status))) return "active";
  if (workItems.some((item) => ATTENTION_STATUSES.has(item.status))) return "attention";
  if (dispatches.some((dispatch) => dispatch.status === "queued")) return "queued";
  if (dispatches.some((dispatch) => dispatch.status === "dispatching")) return "dispatching";
  if (dispatches.some((dispatch) => dispatch.status === "needs_user")) return "needs input";
  if (utterance.status === "failed") return "failed";
  if (workItems.some((item) => item.status === "done")) return "done";
  return utterance.status;
}

function callTurnStatusForThread(
  utterances: CallUtterance[],
  dispatchesByUtterance: Map<string, CallDispatch[]>,
  workItemsByUtterance: Map<string, AgentWorkItem[]>,
) {
  let fallbackStatus = "acknowledged";
  for (const utterance of utterances) {
    const dispatches = dispatchesByUtterance.get(utterance.id) ?? [];
    const workItems = workItemsByUtterance.get(utterance.id) ?? [];
    const status = callTurnStatus(utterance, dispatches, workItems);
    if (status === "active" || status === "dispatching" || status === "queued") return status;
    if (status === "needs input" || status === "attention" || status === "failed") fallbackStatus = status;
    else if (status === "done" && fallbackStatus === "acknowledged") fallbackStatus = status;
    else if (utterance.status && fallbackStatus === "acknowledged") fallbackStatus = utterance.status;
  }
  return fallbackStatus;
}
