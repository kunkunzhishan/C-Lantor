import { describe, expect, it, vi } from "vitest";
import { activeProgressByAgent, sourceKindMeta } from "./ActivityProgressDock";
import type { Agent, AgentActivity, AgentRun, AgentWorkItem, Message } from "../types";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    handle: "kunk",
    display_name: "kunk",
    role: "agent",
    status: "idle",
    runtime: "codex",
    model: "gpt",
    reasoning_effort: "medium",
    service_tier: "",
    avatar: "",
    description: "",
    launch_command: "",
    working_directory: "",
    workspace_exists: false,
    workspace_memory_path: "",
    workspace_memory_exists: false,
    workspace_entries: [],
    daily_budget_micros: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agent_id: "agent-1",
    agent_handle: "kunk",
    work_item_id: "work-1",
    command: "codex app-server --listen stdio://",
    working_directory: "",
    status: "starting",
    pid: null,
    exit_code: null,
    log: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
    started_at: "2026-05-25T07:00:00.000+00:00",
    stopped_at: null,
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "work-1",
    agent_id: "agent-1",
    agent_handle: "kunk",
    channel_id: "channel-1",
    channel_name: "性能优化",
    thread_root_id: "thread-1",
    source_message_id: null,
    task_id: null,
    task_number: null,
    call_session_id: null,
    call_utterance_id: null,
    call_dispatch_id: null,
    source_kind: "thread_followup",
    title: "Process inbox",
    context: "",
    status: "running",
    run_id: "run-1",
    created_at: "2026-05-25T07:00:00.000+00:00",
    updated_at: "2026-05-25T07:00:01.000+00:00",
    completed_at: null,
    ...overrides,
  };
}

function makeActivity(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: "activity-1",
    agent_id: "agent-1",
    agent_handle: "kunk",
    run_id: "run-1",
    kind: "thinking",
    phase: "thinking",
    status: "active",
    title: "Thinking",
    summary: "",
    detail: "",
    metadata: {},
    created_at: "2026-05-25T07:00:20.000+00:00",
    ...overrides,
  };
}

describe("activeProgressByAgent", () => {
  it("exposes source metadata for jumpable trigger kinds", () => {
    const meta = sourceKindMeta(makeWorkItem({ source_kind: "mention", source_message_id: "message-1" }));

    expect(meta.label).toBe("Mention");
    expect(meta.tone).toBe("mention");
    expect(meta.jumpable).toBe(true);
  });

  it("shows queued surface work even before a run is assigned", () => {
    const progress = activeProgressByAgent(
      [] as Message[],
      [],
      [],
      [makeWorkItem({ run_id: null, status: "queued" })],
      [makeAgent()],
      "channel-1",
      "thread-1",
    );

    expect(progress).toHaveLength(1);
    expect(progress[0].state).toBe("queued");
    expect(progress[0].queuedItems).toHaveLength(1);
    expect(progress[0].queuedItems[0].id).toBe("work-1");
  });

  it("does not keep showing an old starting run with no pid or activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T07:02:00.000+00:00"));
    try {
      const progress = activeProgressByAgent(
        [] as Message[],
        [],
        [makeRun()],
        [makeWorkItem()],
        [makeAgent()],
        "channel-1",
        "thread-1",
      );
      expect(progress).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still shows a fresh starting run while launch is in progress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T07:00:20.000+00:00"));
    try {
      const progress = activeProgressByAgent(
        [] as Message[],
        [],
        [makeRun()],
        [makeWorkItem()],
        [makeAgent()],
        "channel-1",
        "thread-1",
      );
      expect(progress).toHaveLength(1);
      expect(progress[0].agent.handle).toBe("kunk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing a starting run that has useful activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T07:02:00.000+00:00"));
    try {
      const progress = activeProgressByAgent(
        [] as Message[],
        [makeActivity()],
        [makeRun()],
        [makeWorkItem()],
        [makeAgent()],
        "channel-1",
        "thread-1",
      );
      expect(progress).toHaveLength(1);
      expect(progress[0].latestActivity?.title).toBe("Thinking");
    } finally {
      vi.useRealTimers();
    }
  });
});
