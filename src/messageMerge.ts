import type { Message } from "./types";

function timestampValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isComplete(message: Message) {
  return message.delivery_state === "complete";
}

function isStreaming(message: Message) {
  return message.delivery_state === "streaming";
}

export function sortedMessages(messages: Message[]) {
  return [...messages].sort((left, right) => timestampValue(left.created_at) - timestampValue(right.created_at));
}

export function mergeMessageVersion(existing: Message | undefined, incoming: Message) {
  if (!existing) return incoming;

  if (isComplete(existing) && !isComplete(incoming)) return existing;

  const existingUpdatedAt = timestampValue(existing.updated_at);
  const incomingUpdatedAt = timestampValue(incoming.updated_at);
  const incomingIsOlder = incomingUpdatedAt > 0 && existingUpdatedAt > 0 && incomingUpdatedAt < existingUpdatedAt;
  const incomingIsShorter = incoming.body.length < existing.body.length;

  if (incomingIsOlder && incomingIsShorter) return existing;
  if (isStreaming(existing) && isStreaming(incoming) && incomingIsShorter) return existing;

  return incoming;
}

export function mergeMessages(existing: Message[], incoming: Message[]) {
  if (incoming.length === 0) return existing;
  const byId = new Map(existing.map((message) => [message.id, message] as const));
  for (const message of incoming) {
    byId.set(message.id, mergeMessageVersion(byId.get(message.id), message));
  }
  return sortedMessages(Array.from(byId.values()));
}
