import { describe, expect, it } from "vitest";
import { compareThreadsByLatestActivity, threadLatestActivityAt } from "./threadActivity";
import type { Message, ThreadActivity, ThreadReplySummary } from "./types";

function root(id: string, createdAt: string): Pick<Message, "id" | "created_at"> {
  return { id, created_at: createdAt };
}

function summary(createdAt: string): Pick<ThreadReplySummary, "latest"> {
  return {
    latest: { created_at: createdAt } as Message,
  };
}

function activity(latestVisibleAt: string): Pick<ThreadActivity, "latest_visible_at"> {
  return { latest_visible_at: latestVisibleAt };
}

describe("threadLatestActivityAt", () => {
  it("prefers live latest reply timestamps over bootstrap activity and root timestamps", () => {
    const item = root("thread-1", "2026-05-20T00:00:00.000Z");

    expect(threadLatestActivityAt(
      item,
      summary("2026-05-20T00:30:00.000Z"),
      activity("2026-05-20T00:20:00.000Z"),
    )).toBe("2026-05-20T00:30:00.000Z");
  });

  it("uses bootstrap activity when it is newer than loaded reply summaries", () => {
    expect(threadLatestActivityAt(
      root("thread-1", "2026-05-20T00:00:00.000Z"),
      summary("2026-05-20T00:10:00.000Z"),
      activity("2026-05-20T00:30:00.000Z"),
    )).toBe("2026-05-20T00:30:00.000Z");
  });

  it("falls back to bootstrap latest visible activity when replies are not loaded", () => {
    expect(threadLatestActivityAt(
      root("thread-1", "2026-05-20T00:00:00.000Z"),
      undefined,
      activity("2026-05-20T00:20:00.000Z"),
    )).toBe("2026-05-20T00:20:00.000Z");
  });

  it("sorts thread roots by latest reply activity instead of root creation time", () => {
    const oldRootWithFreshReply = root("thread-old", "2026-05-20T00:00:00.000Z");
    const newerRootWithOlderReply = root("thread-new", "2026-05-20T00:10:00.000Z");
    const roots = [newerRootWithOlderReply, oldRootWithFreshReply];

    roots.sort((left, right) => compareThreadsByLatestActivity(
      left,
      right,
      {
        "thread-new": summary("2026-05-20T00:12:00.000Z"),
        "thread-old": summary("2026-05-20T00:30:00.000Z"),
      },
      new Map(),
    ));

    expect(roots.map((item) => item.id)).toEqual(["thread-old", "thread-new"]);
  });
});
