import type { Message, ThreadActivity, ThreadReplySummary } from "./types";
import { timestampMs } from "./ui-utils";

type ThreadRootMessage = Pick<Message, "created_at" | "id">;
type ThreadActivitySummary = Pick<ThreadReplySummary, "latest"> | null | undefined;
type ThreadActivityBootstrap = Pick<ThreadActivity, "latest_visible_at"> | null | undefined;

export function threadLatestActivityAt(
  root: ThreadRootMessage,
  summary: ThreadActivitySummary,
  activity: ThreadActivityBootstrap,
) {
  return [root.created_at, summary?.latest?.created_at, activity?.latest_visible_at]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0] ?? root.created_at;
}

export function compareThreadsByLatestActivity(
  left: ThreadRootMessage,
  right: ThreadRootMessage,
  summaries: Record<string, Pick<ThreadReplySummary, "latest"> | undefined>,
  activities: Map<string, Pick<ThreadActivity, "latest_visible_at">>,
) {
  const rightLatest = threadLatestActivityAt(right, summaries[right.id], activities.get(right.id));
  const leftLatest = threadLatestActivityAt(left, summaries[left.id], activities.get(left.id));
  return timestampMs(rightLatest) - timestampMs(leftLatest);
}
