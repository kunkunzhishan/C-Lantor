import { describe, expect, it } from "vitest";
import { buildCallTimelineRows, callModeStatusText, callTimelineBadge } from "./callModeTimeline";
import { buildCallWorkBoardItems, callWorkBoardStatusLabel } from "./callModeWorkBoard";
import type { Agent, AgentWorkItem, CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult } from "./types";

function makeSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    id: "call-session-1",
    channel_id: "channel-1",
    thread_root_id: null,
    status: "active",
    title: "Call",
    started_at: "2026-05-24T00:00:00.000Z",
    ended_at: null,
    updated_at: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function makeUtterance(overrides: Partial<CallUtterance> = {}): CallUtterance {
  const sequence = overrides.sequence ?? 1;
  return {
    id: `utterance-${sequence}`,
    session_id: "call-session-1",
    thread_root_utterance_id: null,
    sequence,
    transcript: `utterance ${sequence}`,
    language: "en-US",
    transcription_provider: "deterministic",
    transcription_error: "",
    audio_mime_type: "audio/webm",
    audio_original_name: null,
    audio_duration_ms: null,
    status: "dispatched",
    created_at: `2026-05-24T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
    updated_at: `2026-05-24T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function makeDispatch(utterance: CallUtterance, overrides: Partial<CallDispatch> = {}): CallDispatch {
  return {
    id: `dispatch-${utterance.id}`,
    session_id: utterance.session_id,
    utterance_id: utterance.id,
    utterance_sequence: utterance.sequence,
    intent: "delegate",
    ack_status: "understood",
    ack_text: `ack ${utterance.sequence}`,
    speech_topic: "",
    confidence: "high",
    target_agent_id: null,
    work_item_id: null,
    compensated_work_item_id: null,
    long_task_id: null,
    status: "acknowledged",
    outcome: "acknowledged_pending_work",
    status_text: "Acknowledged",
    correlation_key: `correlation-${utterance.id}`,
    correlation_trail: [],
    error: "",
    created_at: utterance.created_at,
    updated_at: utterance.updated_at,
    ...overrides,
  };
}

function makeSubmitResult(
  session: CallSession,
  utterance: CallUtterance,
  dispatch = makeDispatch(utterance),
): CallUtteranceSubmitResult {
  return {
    session,
    utterance,
    dispatch,
    ack_text: dispatch.ack_text,
    work_item_id: dispatch.work_item_id,
    long_task_id: dispatch.long_task_id,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    handle: "dylan",
    display_name: "Dylan",
    role: "worker",
    status: "idle",
    runtime: "codex",
    model: "gpt",
    reasoning_effort: "medium",
    service_tier: "auto",
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

function makeWorkItem(overrides: Partial<AgentWorkItem> = {}): AgentWorkItem {
  return {
    id: "work-item-1",
    agent_id: "agent-1",
    agent_handle: "dylan",
    channel_id: "channel-1",
    channel_name: "ops",
    thread_root_id: null,
    source_message_id: null,
    task_id: null,
    task_number: null,
    call_session_id: "call-session-1",
    call_utterance_id: "utterance-1",
    call_dispatch_id: "dispatch-utterance-1",
    source_kind: "call_mode",
    title: "Prepare the release notes",
    context: "Call Mode utterance",
    status: "queued",
    run_id: null,
    created_at: "2026-05-24T00:00:03.000Z",
    updated_at: "2026-05-24T00:00:03.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("callModeStatusText", () => {
  it("prioritizes a current error over a stale ACK", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const result = makeSubmitResult(session, utterance, makeDispatch(utterance, {
      ack_text: "Stale ACK that should not mask failure",
    }));

    expect(callModeStatusText("Dispatcher unavailable", result)).toBe("Dispatcher unavailable");
  });

  it("falls back to the last ACK and then readiness text", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const result = makeSubmitResult(session, utterance, makeDispatch(utterance, {
      ack_text: "Heard, routing now.",
    }));

    expect(callModeStatusText(null, result)).toBe("Heard, routing now.");
    expect(callModeStatusText(null, null)).toBe("Ready for utterance submit");
  });

  it("does not surface wake-word-required ignored ACKs as status text", () => {
    const session = makeSession();
    const utterance = makeUtterance({
      status: "ignored",
      transcription_error: "wake word required: 小帅,小美,Lantor",
    });
    const result = makeSubmitResult(session, utterance, makeDispatch(utterance, {
      ack_text: "等待唤醒词。",
      status: "ignored",
      outcome: "ignored",
      error: "wake word required: 小帅,小美,Lantor",
    }));

    expect(callModeStatusText(null, result)).toBe("Ready for utterance submit");
  });

  it("uses ended-call status text when there is no current ACK", () => {
    const session = makeSession({
      status: "ended",
      ended_at: "2026-05-24T00:04:00.000Z",
    });

    expect(callModeStatusText(null, null, session)).toBe("Call ended. Utterance input is disabled.");
  });
});

describe("buildCallTimelineRows", () => {
  it("renders an optimistic receipt before canonical session patches arrive", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const result = makeSubmitResult(session, utterance);

    const rows = buildCallTimelineRows(session, [], [], [result]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: utterance.id,
      utterance,
      dispatch: result.dispatch,
      optimistic: true,
    });
    expect(callTimelineBadge(rows[0])).toBe("Processing");
  });

  it("reconciles optimistic receipts with canonical dispatches", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const staleReceiptDispatch = makeDispatch(utterance, {
      id: "dispatch-stale",
      ack_text: "stale ack",
      status: "acknowledged",
      outcome: "acknowledged_pending_work",
    });
    const canonicalDispatch = makeDispatch(utterance, {
      id: "dispatch-canonical",
      ack_text: "canonical ack",
      status: "queued",
      outcome: "work_queued",
      work_item_id: "work-item-1",
    });

    const rows = buildCallTimelineRows(
      session,
      [utterance],
      [canonicalDispatch],
      [makeSubmitResult(session, utterance, staleReceiptDispatch)],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].optimistic).toBe(false);
    expect(rows[0].dispatch).toBe(canonicalDispatch);
    expect(callTimelineBadge(rows[0])).toBe("Assigned");
  });

  it("labels work-linked cancel outcomes as cancellation instead of assignment", () => {
    const session = makeSession();
    const utterance = makeUtterance({
      transcript: "cancel the last one",
    });
    const dispatch = makeDispatch(utterance, {
      intent: "cancel_work",
      status: "queued",
      outcome: "work_cancel_requested",
      work_item_id: "work-item-1",
    });

    const rows = buildCallTimelineRows(session, [utterance], [dispatch], []);

    expect(callTimelineBadge(rows[0])).toBe("Cancelling");
  });

  it("labels resolved pending confirmations with deliberate timeline copy", () => {
    const session = makeSession();
    const utterance = makeUtterance({
      transcript: "maybe send this over there",
    });
    const dispatch = makeDispatch(utterance, {
      ack_status: "understood",
      ack_text: "Resolved. Corrected to @Bob and assigned this call request.",
      status: "superseded",
      outcome: "superseded",
      status_text: "Pending confirmation resolved.",
    });

    const rows = buildCallTimelineRows(session, [utterance], [dispatch], []);

    expect(rows[0].dispatch?.ack_text).toBe(
      "Resolved. Corrected to @Bob and assigned this call request.",
    );
    expect(callTimelineBadge(rows[0])).toBe("Handled");
  });

  it("keeps receipts scoped to the visible session and caps the timeline", () => {
    const session = makeSession();
    const otherSession = makeSession({ id: "call-session-2" });
    const visibleResults = Array.from({ length: 7 }, (_, index) => {
      const utterance = makeUtterance({ id: `utterance-${index + 1}`, sequence: index + 1 });
      return makeSubmitResult(session, utterance);
    });
    const otherUtterance = makeUtterance({
      id: "other-utterance",
      session_id: otherSession.id,
      sequence: 99,
    });

    const rows = buildCallTimelineRows(
      session,
      [],
      [],
      [
        makeSubmitResult(otherSession, otherUtterance, makeDispatch(otherUtterance)),
        ...visibleResults,
      ],
    );

    expect(rows.map((row) => row.utterance.sequence)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(rows.every((row) => row.utterance.session_id === session.id)).toBe(true);
  });

  it("preserves important dispatcher decisions when capping routine timeline rows", () => {
    const session = makeSession();
    const utterances = Array.from({ length: 8 }, (_, index) =>
      makeUtterance({ id: `utterance-${index + 1}`, sequence: index + 1 }),
    );
    const dispatches = utterances.map((utterance) => makeDispatch(utterance, {
      intent: "ack_only",
      ack_status: "heard",
      status: "acknowledged",
      outcome: "acknowledged",
    }));
    dispatches[0] = makeDispatch(utterances[0], {
      ack_status: "needs_target",
      ack_text: "I need to know which agent should handle it.",
      status: "needs_user",
      outcome: "needs_user",
    });

    const rows = buildCallTimelineRows(session, utterances, dispatches, []);

    expect(rows.map((row) => row.utterance.sequence)).toEqual([1, 4, 5, 6, 7, 8]);
    expect(rows[0].dispatch?.status).toBe("needs_user");
  });

  it("prioritizes unresolved and in-flight rows over newer important rows when capped", () => {
    const session = makeSession();
    const utterances = Array.from({ length: 8 }, (_, index) =>
      makeUtterance({
        id: `utterance-${index + 1}`,
        sequence: index + 1,
        status: index === 0 ? "dispatching" : "dispatched",
      }),
    );
    const dispatches = utterances.slice(1).map((utterance) => makeDispatch(utterance, {
      ack_status: "unsupported",
      ack_text: "That call command is not supported yet.",
      status: "ignored",
      outcome: "ignored",
    }));
    dispatches[0] = makeDispatch(utterances[1], {
      ack_status: "needs_target",
      ack_text: "Which agent should handle that?",
      status: "needs_user",
      outcome: "needs_user",
    });

    const rows = buildCallTimelineRows(session, utterances, dispatches, []);

    expect(rows.map((row) => row.utterance.sequence)).toEqual([1, 2, 5, 6, 7, 8]);
    expect(rows[0].utterance.status).toBe("dispatching");
    expect(rows[0].dispatch).toBeNull();
    expect(rows[1].dispatch?.status).toBe("needs_user");
  });

  it("does not preserve ignored no-speech diagnostics as unresolved priority rows when capped", () => {
    const session = makeSession();
    const utterances = Array.from({ length: 8 }, (_, index) => makeUtterance({
      id: `utterance-${index + 1}`,
      sequence: index + 1,
    }));
    const dispatches = utterances.map((utterance) => makeDispatch(utterance, {
      intent: "ack_only",
      ack_status: "heard",
      status: "acknowledged",
      outcome: "acknowledged",
    }));

    utterances[0] = makeUtterance({
      id: "utterance-1",
      sequence: 1,
      transcript: "",
      transcription_error: "emptyTranscript: no speech detected",
      status: "ignored",
    });
    dispatches[0] = makeDispatch(utterances[0], {
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "这段没有检测到说话，我先忽略了。",
      confidence: "low",
      status: "ignored",
      outcome: "ignored",
      error: "emptyTranscript: no speech detected",
    });

    const rows = buildCallTimelineRows(session, utterances, dispatches, []);

    expect(rows.map((row) => row.utterance.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(rows.some((row) => row.utterance.transcription_error)).toBe(false);
  });

  it("hides routine ignored no-speech diagnostics from the visible timeline", () => {
    const session = makeSession();
    const utterances = Array.from({ length: 3 }, (_, index) => makeUtterance({
      id: `utterance-ignored-${index + 1}`,
      sequence: index + 1,
      transcript: "",
      transcription_error: "providerFailed: No speech detected",
      status: "ignored",
    }));
    const dispatches = utterances.map((utterance) => makeDispatch(utterance, {
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "这段没有检测到说话，我先忽略了。",
      confidence: "low",
      status: "ignored",
      outcome: "ignored",
      error: "providerFailed: No speech detected",
    }));

    expect(buildCallTimelineRows(session, utterances, dispatches, [])).toEqual([]);
  });

  it("hides wake-word-required ignored turns from the visible timeline", () => {
    const session = makeSession();
    const utterance = makeUtterance({
      id: "utterance-wake-required",
      sequence: 1,
      transcript: "他妈，他这个到底怎么回事？这个代码怎么气呀？",
      transcription_error: "wake word required: 小帅,小美,Lantor",
      status: "ignored",
    });
    const dispatch = makeDispatch(utterance, {
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "等待唤醒词。",
      status: "ignored",
      outcome: "ignored",
      error: "wake word required: 小帅,小美,Lantor",
    });

    expect(buildCallTimelineRows(session, [utterance], [dispatch], [])).toEqual([]);
  });

  it("hides failed no-speech diagnostics from the visible timeline", () => {
    const session = makeSession();
    const utterance = makeUtterance({
      id: "utterance-failed-no-speech",
      sequence: 1,
      transcript: "",
      transcription_error: "emptyTranscript: No speech detected in 12s audio",
      status: "failed",
    });
    const dispatch = makeDispatch(utterance, {
      intent: "ack_only",
      ack_status: "transcription_failed",
      ack_text: "这段语音比较长，但没有转写成功。",
      status: "failed",
      outcome: "failed",
      error: "emptyTranscript: No speech detected in 12s audio",
    });

    expect(buildCallTimelineRows(session, [utterance], [dispatch], [])).toEqual([]);
  });
});

describe("buildCallWorkBoardItems", () => {
  it("shows an acknowledged work dispatch before the worker link arrives", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const dispatch = makeDispatch(utterance, {
      target_agent_id: "agent-1",
      intent: "agent_work",
      status: "acknowledged",
      outcome: "acknowledged_pending_work",
      status_text: "Acknowledged, linking worker",
    });

    const items = buildCallWorkBoardItems(
      session,
      [],
      [],
      [makeAgent()],
      [makeSubmitResult(session, utterance, dispatch)],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      dispatch,
      workItem: null,
      agentHandle: "dylan",
      sequence: 1,
      requestNumber: 1,
      status: "linking",
      tone: "pending",
      isLive: true,
    });
    expect(callWorkBoardStatusLabel(items[0])).toBe("linking");
  });

  it("does not show ignored ACKs as live work", () => {
    const session = makeSession();
    const utterance = makeUtterance({ id: "utterance-recovery", sequence: 5, status: "ignored" });
    const recovery = makeDispatch(utterance, {
      id: "dispatch-recovery",
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "I still need your confirmation before I assign that.",
      target_agent_id: "agent-1",
      status: "ignored",
      outcome: "ignored",
      status_text: "Ignored.",
      error: "ignored_ack",
    });
    const rejectionAck = makeDispatch(makeUtterance({ id: "utterance-reject", sequence: 6 }), {
      id: "dispatch-reject",
      intent: "ack_only",
      ack_status: "understood",
      ack_text: "Okay, I will not assign that call request.",
      target_agent_id: "agent-1",
      status: "acknowledged",
      outcome: "acknowledged",
      status_text: "Heard and acknowledged.",
    });

    const items = buildCallWorkBoardItems(
      session,
      [recovery, rejectionAck],
      [],
      [makeAgent()],
      [makeSubmitResult(session, utterance, recovery)],
    );

    expect(items).toEqual([]);
  });

  it("reconciles dispatcher links with call-linked work item status patches", () => {
    const session = makeSession();
    const utterance = makeUtterance();
    const dispatch = makeDispatch(utterance, {
      id: "dispatch-utterance-1",
      target_agent_id: "agent-1",
      work_item_id: "work-item-1",
      intent: "agent_work",
      status: "queued",
      outcome: "work_queued",
      status_text: "Worker accepted the request",
    });
    const workItem = makeWorkItem({
      status: "running",
      run_id: "run-1",
      updated_at: "2026-05-24T00:00:05.000Z",
    });

    const items = buildCallWorkBoardItems(session, [dispatch], [workItem], [makeAgent()]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "work-item-1",
      dispatch,
      workItem,
      title: "Prepare the release notes",
      requestNumber: 1,
      status: "running",
      statusText: "Worker accepted the request",
      tone: "active",
      isLive: true,
    });
    expect(callWorkBoardStatusLabel(items[0])).toBe("running");
  });

  it("keeps orphaned call-linked work visible when the dispatch patch is missing", () => {
    const session = makeSession();
    const utterance = makeUtterance({ id: "utterance-orphan", sequence: 4 });
    const workItem = makeWorkItem({
      id: "work-item-orphan",
      call_utterance_id: utterance.id,
      call_dispatch_id: "dispatch-not-in-bootstrap",
      status: "failed",
      updated_at: "2026-05-24T00:00:07.000Z",
    });

    const items = buildCallWorkBoardItems(session, [], [workItem], [makeAgent()], [], [utterance]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "work-item-orphan",
      dispatch: null,
      requestNumber: 4,
      sequence: 4,
      status: "failed",
      tone: "attention",
      isLive: false,
    });
  });
});
