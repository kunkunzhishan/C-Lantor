import type { Message } from "./types";
import { timestampMs } from "./ui-utils";

export function messageRunId(message: Message) {
  const [runId] = message.stream_key.split(":");
  if (!runId) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
    ? runId
    : null;
}

export function messageHasVisibleContent(message: Message) {
  return Boolean(message.body.trim() || message.attachments.length > 0 || message.artifacts.length > 0);
}

export function isProgressOnlyMessage(message: Message) {
  if (!messageRunId(message)) return false;
  if (message.sender_role === "owner" || message.sender_role === "system") return false;
  if (message.delivery_state === "streaming" || message.delivery_state === "complete") {
    return !messageHasVisibleContent(message);
  }
  return false;
}

export function wasEdited(message: Message) {
  if (message.stream_key) return false;
  const created = timestampMs(message.created_at);
  const updated = timestampMs(message.updated_at);
  return Number.isFinite(created) && Number.isFinite(updated) && updated - created > 1000;
}

export function isCompactFollowupMessage(message: Message, previous: Message | null | undefined) {
  void message;
  void previous;
  return false;
}
