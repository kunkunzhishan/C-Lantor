import type { Agent, AgentWorkItem, CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult } from "./types";

const CALL_WORK_BOARD_LIMIT = 6;
const ACTIVE_WORK_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_WORK_STATUSES = new Set(["done", "failed", "cancelled", "silent"]);
const ATTENTION_WORK_STATUSES = new Set(["failed", "cancelled", "cancelling"]);
const WORK_DISPATCH_OUTCOMES = new Set([
  "acknowledged_pending_work",
  "work_queued",
  "long_task_queued",
  "dispatch_failed",
  "work_link_compensated",
  "work_link_compensation_failed",
]);

export type CallWorkBoardTone = "pending" | "active" | "done" | "attention";

export type CallWorkBoardItem = {
  id: string;
  dispatch: CallDispatch | null;
  workItem: AgentWorkItem | null;
  agentHandle: string | null;
  title: string;
  sequence: number | null;
  requestNumber: number | null;
  status: string;
  statusText: string;
  tone: CallWorkBoardTone;
  isLive: boolean;
  createdAt: string;
  updatedAt: string;
};

export function buildCallWorkBoardItems(
  session: CallSession | null,
  callDispatches: CallDispatch[],
  agentWorkItems: AgentWorkItem[],
  agents: Agent[],
  submitResults: CallUtteranceSubmitResult[] = [],
  callUtterances: CallUtterance[] = [],
): CallWorkBoardItem[] {
  if (!session) return [];

  const agentHandleById = new Map(agents.map((agent) => [agent.id, agent.handle]));
  const dispatches = canonicalCallDispatches(session.id, callDispatches, submitResults)
    .filter(isWorkDispatch);
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.id, dispatch]));
  const workItems = agentWorkItems.filter((item) => item.call_session_id === session.id);
  const workItemById = new Map(workItems.map((item) => [item.id, item]));
  const workItemByDispatchId = new Map(
    workItems
      .filter((item) => item.call_dispatch_id)
      .map((item) => [item.call_dispatch_id as string, item]),
  );
  const utteranceSequenceById = new Map([
    ...callUtterances
      .filter((utterance) => utterance.session_id === session.id)
      .map((utterance) => [utterance.id, utterance.sequence] as const),
    ...submitResults
      .filter((result) => result.session.id === session.id)
      .map((result) => [result.utterance.id, result.utterance.sequence] as const),
  ]);

  const rows = new Map<string, CallWorkBoardItem>();
  for (const dispatch of dispatches) {
    const workItem = dispatch.work_item_id
      ? workItemById.get(dispatch.work_item_id) ?? workItemByDispatchId.get(dispatch.id) ?? null
      : workItemByDispatchId.get(dispatch.id) ?? null;
    rows.set(`dispatch:${dispatch.id}`, callWorkBoardItemFromDispatch(
      dispatch,
      workItem,
      dispatch.target_agent_id ? agentHandleById.get(dispatch.target_agent_id) ?? null : null,
    ));
  }

  for (const workItem of workItems) {
    if (workItem.status === "silent") continue;
    const dispatch = workItem.call_dispatch_id ? dispatchById.get(workItem.call_dispatch_id) ?? null : null;
    if (dispatch) continue;
    rows.set(
      `work:${workItem.id}`,
      callWorkBoardItemFromWorkItem(
        workItem,
        null,
        workItem.call_utterance_id ? utteranceSequenceById.get(workItem.call_utterance_id) ?? null : null,
      ),
    );
  }

  return Array.from(rows.values())
    .sort(compareCallWorkBoardItems)
    .slice(0, CALL_WORK_BOARD_LIMIT);
}

export function callWorkBoardStatusLabel(item: CallWorkBoardItem) {
  return item.status.replace(/_/g, " ");
}

function canonicalCallDispatches(
  sessionId: string,
  callDispatches: CallDispatch[],
  submitResults: CallUtteranceSubmitResult[],
) {
  const canonicalByUtterance = new Map(
    callDispatches
      .filter((dispatch) => dispatch.session_id === sessionId)
      .map((dispatch) => [dispatch.utterance_id, dispatch]),
  );
  const dispatches = new Map<string, CallDispatch>();
  for (const dispatch of canonicalByUtterance.values()) {
    dispatches.set(dispatch.id, dispatch);
  }
  for (const result of submitResults) {
    if (result.session.id !== sessionId) continue;
    if (canonicalByUtterance.has(result.utterance.id)) continue;
    dispatches.set(result.dispatch.id, result.dispatch);
  }
  return Array.from(dispatches.values());
}

function isWorkDispatch(dispatch: CallDispatch) {
  if (dispatch.intent === "ack_only") return false;
  return Boolean(
    dispatch.work_item_id
    || dispatch.long_task_id
    || dispatch.intent.includes("work")
    || dispatch.intent === "long_task"
    || WORK_DISPATCH_OUTCOMES.has(dispatch.outcome),
  );
}

function callWorkBoardItemFromDispatch(
  dispatch: CallDispatch,
  workItem: AgentWorkItem | null,
  targetAgentHandle: string | null,
): CallWorkBoardItem {
  if (workItem) return callWorkBoardItemFromWorkItem(workItem, dispatch);

  const status = dispatch.status === "acknowledged" && dispatch.outcome === "acknowledged_pending_work"
    ? "linking"
    : dispatch.status;
  const tone = dispatch.status === "failed" || dispatch.status === "compensated"
    ? "attention"
    : "pending";
  const statusText = dispatch.status_text || dispatch.error || dispatch.ack_text || "Waiting for worker status";
  return {
    id: dispatch.id,
    dispatch,
    workItem: null,
    agentHandle: targetAgentHandle,
    title: dispatch.long_task_id ? `Long task ${dispatch.long_task_id}` : `Call turn #${dispatch.utterance_sequence}`,
    sequence: dispatch.utterance_sequence,
    requestNumber: dispatch.utterance_sequence,
    status,
    statusText,
    tone,
    isLive: tone === "pending",
    createdAt: dispatch.created_at,
    updatedAt: dispatch.updated_at,
  };
}

function callWorkBoardItemFromWorkItem(
  workItem: AgentWorkItem,
  dispatch: CallDispatch | null,
  fallbackRequestNumber: number | null = null,
): CallWorkBoardItem {
  const tone = callWorkBoardToneForWorkStatus(workItem.status);
  const requestNumber = dispatch?.utterance_sequence ?? fallbackRequestNumber;
  return {
    id: workItem.id,
    dispatch,
    workItem,
    agentHandle: workItem.agent_handle,
    title: workItem.title || dispatch?.ack_text || "Call Mode request",
    sequence: requestNumber,
    requestNumber,
    status: workItem.status,
    statusText: dispatch?.status_text || dispatch?.ack_text || workStatusText(workItem.status),
    tone,
    isLive: ACTIVE_WORK_STATUSES.has(workItem.status),
    createdAt: workItem.created_at,
    updatedAt: workItem.updated_at,
  };
}

function callWorkBoardToneForWorkStatus(status: string): CallWorkBoardTone {
  if (ACTIVE_WORK_STATUSES.has(status)) return "active";
  if (status === "done") return "done";
  if (ATTENTION_WORK_STATUSES.has(status)) return "attention";
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

function compareCallWorkBoardItems(left: CallWorkBoardItem, right: CallWorkBoardItem) {
  const leftPriority = callWorkBoardPriority(left);
  const rightPriority = callWorkBoardPriority(right);
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  const updatedDelta = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  if (updatedDelta !== 0) return updatedDelta;
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function callWorkBoardPriority(item: CallWorkBoardItem) {
  if (item.isLive) return 3;
  if (item.tone === "attention") return 2;
  if (!TERMINAL_WORK_STATUSES.has(item.status)) return 1;
  return 0;
}
