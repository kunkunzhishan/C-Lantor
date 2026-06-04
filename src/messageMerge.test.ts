import { describe, expect, it } from "vitest";
import { mergeMessageVersion, mergeMessages } from "./messageMerge";
import type { Message } from "./types";

function message(overrides: Partial<Message>): Message {
  return {
    id: "message-1",
    channel_id: "channel-1",
    thread_root_id: null,
    sender_agent_id: "agent-1",
    sender_name: "Agent",
    sender_role: "worker",
    body: "",
    is_task: false,
    thread_followed: false,
    delivery_state: "streaming",
    stream_key: "stream-1",
    task_number: null,
    task_status: null,
    attachments: [],
    artifacts: [],
    created_at: "2026-06-03T09:29:20.000Z",
    updated_at: "2026-06-03T09:29:20.000Z",
    ...overrides,
  };
}

describe("message merge", () => {
  it("does not let a bootstrap streaming snapshot replace a completed message", () => {
    const existing = message({
      body: "You mean the Lantor tools tool_browser.open result is complete.",
      delivery_state: "complete",
      updated_at: "2026-06-03T09:29:37.234Z",
    });
    const incoming = message({
      body: "You mean the Lantor tools",
      delivery_state: "streaming",
      updated_at: "2026-06-03T09:29:35.020Z",
    });

    expect(mergeMessageVersion(existing, incoming)).toBe(existing);
  });

  it("keeps a longer local streaming body over a shorter streaming bootstrap body", () => {
    const existing = message({
      body: "You mean the Lantor tools tool_browser.open",
      delivery_state: "streaming",
      updated_at: "2026-06-03T09:29:35.348Z",
    });
    const incoming = message({
      body: "You mean the Lantor tools",
      delivery_state: "streaming",
      updated_at: "2026-06-03T09:29:35.020Z",
    });

    expect(mergeMessageVersion(existing, incoming)).toBe(existing);
  });

  it("accepts a complete incoming message over a streaming local message", () => {
    const existing = message({
      body: "You mean the Lantor tools",
      delivery_state: "streaming",
      updated_at: "2026-06-03T09:29:35.020Z",
    });
    const incoming = message({
      body: "You mean the Lantor tools tool_browser.open result is complete.",
      delivery_state: "complete",
      updated_at: "2026-06-03T09:29:37.234Z",
    });

    expect(mergeMessageVersion(existing, incoming)).toBe(incoming);
  });

  it("sorts merged messages by created_at", () => {
    const first = message({ id: "first", created_at: "2026-06-03T09:29:20.000Z" });
    const second = message({ id: "second", created_at: "2026-06-03T09:29:21.000Z" });

    expect(mergeMessages([second], [first]).map((item) => item.id)).toEqual(["first", "second"]);
  });
});
