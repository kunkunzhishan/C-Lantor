import { describe, expect, it } from "vitest";
import { buildCallTurns } from "./callModeTurns";
import type { AgentWorkItem, CallDispatch, CallSession, CallUtterance } from "./types";

function makeSession(): CallSession {
  return {
    id: "call-session-1",
    channel_id: null,
    thread_root_id: null,
    status: "active",
    title: "Voice Console",
    started_at: "2026-05-26T05:39:00.000Z",
    ended_at: null,
    updated_at: "2026-05-26T05:39:00.000Z",
  };
}

function makeUtterance(): CallUtterance {
  return {
    id: "utterance-1",
    session_id: "call-session-1",
    thread_root_utterance_id: null,
    sequence: 1,
    transcript: "在，有什么需要我处理？",
    language: "zh-CN",
    transcription_provider: "typed",
    transcription_error: "",
    audio_mime_type: "text/plain",
    audio_original_name: null,
    audio_duration_ms: null,
    status: "dispatched",
    created_at: "2026-05-26T05:39:01.000Z",
    updated_at: "2026-05-26T05:39:03.000Z",
  };
}

function makeDispatch(overrides: Partial<CallDispatch>): CallDispatch {
  return {
    id: "dispatch-1",
    session_id: "call-session-1",
    utterance_id: "utterance-1",
    utterance_sequence: 1,
    intent: "ack_only",
    ack_status: "heard",
    ack_text: "在，有什么需要我处理？",
    speech_topic: "",
    confidence: "medium",
    target_agent_id: null,
    work_item_id: null,
    compensated_work_item_id: null,
    long_task_id: null,
    status: "acknowledged",
    outcome: "acknowledged",
    status_text: "Acknowledged",
    correlation_key: "call-session-1:1",
    correlation_trail: [],
    error: "",
    created_at: "2026-05-26T05:39:02.000Z",
    updated_at: "2026-05-26T05:39:02.000Z",
    ...overrides,
  };
}

describe("buildCallTurns", () => {
  it("hides superseded dispatcher queue rows after the final system reply is available", () => {
    const queuedDispatch = makeDispatch({
      id: "dispatch-queued",
      intent: "coordinator_pending",
      ack_status: "resolved",
      status: "superseded",
      status_text: "Resolved",
      error: "resolved by call dispatch dispatch-final",
      created_at: "2026-05-26T05:39:01.500Z",
      updated_at: "2026-05-26T05:39:03.000Z",
    });
    const finalDispatch = makeDispatch({
      id: "dispatch-final",
      created_at: "2026-05-26T05:39:02.000Z",
      updated_at: "2026-05-26T05:39:02.000Z",
    });

    const turns = buildCallTurns(
      makeSession(),
      [makeUtterance()],
      [queuedDispatch, finalDispatch],
      [],
      [],
    );

    expect(turns[0].events.map((event) => event.title)).not.toContain("Dispatcher queue");
    expect(turns[0].events.filter((event) => event.detail === "在，有什么需要我处理？"))
      .toHaveLength(1);
  });

  it("hides no-speech diagnostics from the call thread", () => {
    const utterance = {
      ...makeUtterance(),
      transcript: "",
      transcription_error: "emptyTranscript: No speech detected in 12s audio",
      status: "failed",
      audio_duration_ms: 12_000,
    };
    const dispatch = makeDispatch({
      ack_status: "transcription_failed",
      ack_text: "这段语音比较长，但没有转写成功。",
      status: "failed",
      outcome: "failed",
      error: "emptyTranscript: No speech detected in 12s audio",
    });

    const turns = buildCallTurns(
      makeSession(),
      [utterance],
      [dispatch],
      [],
      [],
    );

    expect(turns).toEqual([]);
  });

  it("hides wake-word-required ignored turns from the call thread", () => {
    const utterance = {
      ...makeUtterance(),
      transcript: "他妈，他这个到底怎么回事？这个代码怎么气呀？",
      transcription_error: "wake word required: 小帅,小美,Lantor",
      status: "ignored",
      audio_duration_ms: 14_000,
    };
    const dispatch = makeDispatch({
      ack_text: "等待唤醒词。",
      status: "ignored",
      outcome: "ignored",
      error: "wake word required: 小帅,小美,Lantor",
    });

    const turns = buildCallTurns(
      makeSession(),
      [utterance],
      [dispatch],
      [],
      [],
    );

    expect(turns).toEqual([]);
  });

  it("keeps all visible Voice turns and worker result bodies", () => {
    const utterances = Array.from({ length: 13 }, (_, index) => ({
      ...makeUtterance(),
      id: `utterance-${index + 1}`,
      sequence: index + 1,
      transcript: `请求 ${index + 1}`,
      created_at: `2026-05-26T05:${String(39 + index).padStart(2, "0")}:01.000Z`,
    }));
    const workItem: AgentWorkItem = {
      id: "work-13",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: null,
      channel_name: null,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: "call-session-1",
      call_utterance_id: "utterance-13",
      call_dispatch_id: "dispatch-13",
      source_kind: "call_mode",
      title: "Worker task",
      context: "Call Mode request",
      result_body: "关于 请求 13，ada说，完整结果。",
      status: "done",
      run_id: "run-13",
      created_at: "2026-05-26T05:51:02.000Z",
      updated_at: "2026-05-26T05:51:03.000Z",
      completed_at: "2026-05-26T05:51:03.000Z",
    };

    const turns = buildCallTurns(makeSession(), utterances, [], [workItem], []);

    expect(turns).toHaveLength(13);
    expect(turns[0].transcript).toBe("请求 1");
    expect(turns[12].events.some((event) => event.detail === "关于 请求 13，ada说，完整结果。")).toBe(true);
  });
});
