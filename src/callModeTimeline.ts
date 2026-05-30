import type { CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult } from "./types";

const CALL_TIMELINE_ROW_LIMIT = 6;
const IN_FLIGHT_UTTERANCE_STATUSES = new Set(["transcribing", "transcribed", "dispatching"]);
const UNRESOLVED_ACK_STATUSES = new Set(["needs_target", "needs_confirmation"]);
const UNRESOLVED_DISPATCH_STATUSES = new Set(["queued", "needs_user", "failed", "compensated"]);
const UNRESOLVED_OUTCOMES = new Set([
  "acknowledged_pending_work",
  "work_queued",
  "long_task_queued",
  "needs_user",
  "dispatch_failed",
  "work_link_compensated",
  "work_link_compensation_failed",
]);
const IMPORTANT_ACK_STATUSES = new Set(["needs_target", "needs_confirmation", "refused", "unsupported"]);
const IMPORTANT_DISPATCH_STATUSES = new Set(["queued", "needs_user", "failed", "compensated"]);
const IMPORTANT_OUTCOMES = new Set([
  "acknowledged_pending_work",
  "work_queued",
  "long_task_queued",
  "needs_user",
  "dispatch_failed",
  "work_link_compensated",
  "work_link_compensation_failed",
]);

export type CallTimelineRow = {
  id: string;
  utterance: CallUtterance;
  dispatch: CallDispatch | null;
  optimistic: boolean;
};

export function buildCallTimelineRows(
  session: CallSession | null,
  callUtterances: CallUtterance[],
  callDispatches: CallDispatch[],
  submitResults: CallUtteranceSubmitResult[],
): CallTimelineRow[] {
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
  const rows = new Map<string, CallTimelineRow>();

  for (const utterance of callUtterances.filter((item) => item.session_id === session.id)) {
    const receipt = submitResultByUtterance.get(utterance.id);
    const dispatch = canonicalDispatchByUtterance.get(utterance.id) ?? receipt?.dispatch ?? null;
    rows.set(utterance.id, {
      id: utterance.id,
      utterance,
      dispatch,
      optimistic: Boolean(receipt && !canonicalDispatchByUtterance.has(utterance.id)),
    });
  }

  for (const result of submitResultByUtterance.values()) {
    if (rows.has(result.utterance.id)) continue;
    rows.set(result.utterance.id, {
      id: result.utterance.id,
      utterance: result.utterance,
      dispatch: result.dispatch,
      optimistic: true,
    });
  }

  return capCallTimelineRows(
    Array.from(rows.values())
      .filter((row) => !isIgnoredCallTimelineDiagnostic(row))
      .sort(compareCallTimelineRows),
  );
}

export function callTimelineBadge(row: CallTimelineRow) {
  if (row.dispatch?.intent === "cancel_work" || row.dispatch?.outcome === "work_cancel_requested") return "Cancelling";
  if (row.dispatch?.work_item_id || row.dispatch?.long_task_id) return "Assigned";
  if (row.dispatch?.status === "queued") return "Assigned";
  if (row.dispatch?.status === "acknowledged" && row.dispatch.intent === "ack_only") return "Replied";
  if (row.dispatch?.status === "acknowledged") return "Processing";
  if (row.dispatch?.status === "superseded" || row.dispatch?.outcome === "superseded") return "Handled";
  if (row.dispatch?.status === "ignored") return "Ignored";
  if (row.dispatch?.status === "failed") return "Failed";
  if (row.dispatch?.outcome) return row.dispatch.outcome.replace(/_/g, " ");
  if (row.dispatch?.status) return row.dispatch.status;
  if (row.optimistic) return "Heard";
  if (row.utterance.status === "acknowledged") return "Replied";
  if (row.utterance.status === "ignored") return "Ignored";
  return row.utterance.status;
}

export function callModeStatusText(
  error: string | null,
  lastResult: CallUtteranceSubmitResult | null,
  session: CallSession | null = null,
) {
  if (error) return error;
  if (lastResult?.ack_text) return lastResult.ack_text;
  if (session?.status && session.status !== "active") {
    if (session.status === "ended") return "Call ended. Utterance input is disabled.";
    if (session.status === "error") return "Call unavailable. Utterance input is disabled.";
    return "Call session is not accepting utterances.";
  }
  return "Ready for utterance submit";
}

function capCallTimelineRows(rows: CallTimelineRow[]) {
  if (rows.length <= CALL_TIMELINE_ROW_LIMIT) return rows;

  const visibleRows = rows.slice(-CALL_TIMELINE_ROW_LIMIT);
  for (const row of rows.slice(0, -CALL_TIMELINE_ROW_LIMIT).reverse()) {
    const rowPriority = callTimelineCapPriority(row);
    if (rowPriority === 0) continue;

    const replaceIndex = findLowestPriorityReplacementIndex(visibleRows, rowPriority);
    if (replaceIndex === -1) continue;
    visibleRows.splice(replaceIndex, 1, row);
  }

  return visibleRows.sort(compareCallTimelineRows);
}

function compareCallTimelineRows(left: CallTimelineRow, right: CallTimelineRow) {
  const sequenceDelta = left.utterance.sequence - right.utterance.sequence;
  if (sequenceDelta !== 0) return sequenceDelta;
  return new Date(left.utterance.created_at).getTime() - new Date(right.utterance.created_at).getTime();
}

function findLowestPriorityReplacementIndex(rows: CallTimelineRow[], incomingPriority: number) {
  const priorities = rows.map(callTimelineCapPriority);
  const lowestPriority = Math.min(...priorities);
  if (lowestPriority >= incomingPriority) return -1;
  return priorities.findIndex((priority) => priority === lowestPriority);
}

function callTimelineCapPriority(row: CallTimelineRow) {
  if (isUnresolvedOrInFlightCallTimelineRow(row)) return 2;
  if (isImportantCallTimelineRow(row)) return 1;
  return 0;
}

function isUnresolvedOrInFlightCallTimelineRow(row: CallTimelineRow) {
  if (isIgnoredCallTimelineDiagnostic(row)) return false;

  return Boolean(
    IN_FLIGHT_UTTERANCE_STATUSES.has(row.utterance.status)
    || row.utterance.status === "failed"
    || row.utterance.transcription_error
    || (row.dispatch?.ack_status && UNRESOLVED_ACK_STATUSES.has(row.dispatch.ack_status))
    || (row.dispatch?.status && UNRESOLVED_DISPATCH_STATUSES.has(row.dispatch.status))
    || (row.dispatch?.outcome && UNRESOLVED_OUTCOMES.has(row.dispatch.outcome)),
  );
}

function isIgnoredCallTimelineDiagnostic(row: CallTimelineRow) {
  if (!row.utterance.transcript && isNoSpeechTranscriptionDiagnostic(row.utterance.transcription_error || row.dispatch?.error)) {
    return true;
  }
  return row.utterance.status === "ignored"
    && row.dispatch?.status === "ignored"
    && row.dispatch?.outcome === "ignored";
}

function isNoSpeechTranscriptionDiagnostic(value: string | null | undefined) {
  const lower = (value ?? "").toLowerCase();
  return lower.includes("no speech")
    || lower.includes("speech was not detected")
    || lower.includes("emptytranscript");
}

function isImportantCallTimelineRow(row: CallTimelineRow) {
  return Boolean(
    isUnresolvedOrInFlightCallTimelineRow(row)
    || row.dispatch?.work_item_id
    || row.dispatch?.long_task_id
    || (row.dispatch?.ack_status && IMPORTANT_ACK_STATUSES.has(row.dispatch.ack_status))
    || (row.dispatch?.status && IMPORTANT_DISPATCH_STATUSES.has(row.dispatch.status))
    || (row.dispatch?.outcome && IMPORTANT_OUTCOMES.has(row.dispatch.outcome)),
  );
}
