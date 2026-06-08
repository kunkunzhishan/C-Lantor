import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelCallDispatchWork,
  resolveCallDispatchConfirmation,
  startCallSession,
  stopCallSession,
  submitRecordedCallUtterance,
  submitTypedCallUtterance,
} from "../callModeClient";
import type { CallSession, CallUtteranceSubmitResult } from "../types";
import { useCallModeSubmit } from "./useCallModeSubmit";

vi.mock("../callModeClient", () => ({
  cancelCallDispatchWork: vi.fn(),
  resolveCallDispatchConfirmation: vi.fn(),
  startCallSession: vi.fn(),
  stopCallSession: vi.fn(),
  submitRecordedCallUtterance: vi.fn(),
  submitTypedCallUtterance: vi.fn(),
}));

const cancelCallDispatchWorkMock = vi.mocked(cancelCallDispatchWork);
const resolveCallDispatchConfirmationMock = vi.mocked(resolveCallDispatchConfirmation);
const startCallSessionMock = vi.mocked(startCallSession);
const stopCallSessionMock = vi.mocked(stopCallSession);
const submitRecordedCallUtteranceMock = vi.mocked(submitRecordedCallUtterance);
const submitTypedCallUtteranceMock = vi.mocked(submitTypedCallUtterance);

const activeSession: CallSession = {
  id: "call-session-1",
  channel_id: "channel-1",
  thread_root_id: null,
  status: "active",
  title: "Call",
  started_at: "2026-05-24T00:00:00.000Z",
  ended_at: null,
  updated_at: "2026-05-24T00:00:01.000Z",
};

const workspaceSession: CallSession = {
  ...activeSession,
  id: "workspace-call-session-1",
  channel_id: null,
  title: "Voice Console",
};

const submitResult: CallUtteranceSubmitResult = {
  session: activeSession,
  utterance: {
    id: "utterance-1",
    session_id: "call-session-1",
    thread_root_utterance_id: null,
    sequence: 1,
    transcript: "ship it",
    language: "en-US",
    transcription_provider: "openai",
    transcription_error: "",
    audio_mime_type: "audio/webm",
    audio_original_name: "call.webm",
    audio_duration_ms: 1200,
    status: "dispatched",
    created_at: "2026-05-24T00:00:01.000Z",
    updated_at: "2026-05-24T00:00:02.000Z",
  },
  dispatch: {
    id: "dispatch-1",
    session_id: "call-session-1",
    utterance_id: "utterance-1",
    utterance_sequence: 1,
    intent: "delegate",
    ack_status: "understood",
    ack_text: "Heard.",
    speech_topic: "",
    confidence: "high",
    target_agent_id: null,
    work_item_id: null,
    compensated_work_item_id: null,
    long_task_id: null,
    status: "acknowledged",
    outcome: "acknowledged_pending_work",
    status_text: "Acknowledged",
    correlation_key: "call-session-1:1",
    correlation_trail: [],
    error: "",
    created_at: "2026-05-24T00:00:02.000Z",
    updated_at: "2026-05-24T00:00:02.000Z",
  },
  ack_text: "Heard.",
  work_item_id: null,
  long_task_id: null,
};

type SubmitHookValue = ReturnType<typeof useCallModeSubmit>;

let latestHook: SubmitHookValue | null = null;
let currentRenderer: ReactTestRenderer | null = null;

const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

function SubmitProbe() {
  latestHook = useCallModeSubmit({
    channelId: "channel-1",
    surfaceSession: activeSession,
  });
  return null;
}

type SubmitProbeOptions = {
  channelId?: string | null;
  surfaceSession?: CallSession | null;
  title?: string;
  mode?: "call" | "wake_word";
  wakeWords?: string;
};

function ConfigurableSubmitProbe({
  channelId = "channel-1",
  surfaceSession = activeSession,
  title,
  mode,
  wakeWords,
}: SubmitProbeOptions) {
  latestHook = useCallModeSubmit({
    channelId,
    surfaceSession,
    title,
    mode,
    wakeWords,
  });
  return null;
}

async function mountSubmitHook(options?: SubmitProbeOptions) {
  await act(async () => {
    currentRenderer = create(React.createElement(options ? ConfigurableSubmitProbe : SubmitProbe, options));
  });

  return {
    get current() {
      if (!latestHook) throw new Error("Submit hook was not mounted.");
      return latestHook;
    },
  };
}

describe("useCallModeSubmit", () => {
  beforeEach(() => {
    latestHook = null;
    currentRenderer = null;
    cancelCallDispatchWorkMock.mockReset();
    cancelCallDispatchWorkMock.mockResolvedValue(submitResult);
    resolveCallDispatchConfirmationMock.mockReset();
    resolveCallDispatchConfirmationMock.mockResolvedValue(submitResult);
    startCallSessionMock.mockReset();
    stopCallSessionMock.mockReset();
    submitRecordedCallUtteranceMock.mockReset();
    submitRecordedCallUtteranceMock.mockResolvedValue(submitResult);
    submitTypedCallUtteranceMock.mockReset();
    submitTypedCallUtteranceMock.mockResolvedValue(submitResult);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (currentRenderer) {
      await act(async () => {
        currentRenderer?.unmount();
      });
    }
    if (originalActEnvironment === undefined) delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    else (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("defaults recorded utterance STT language to Chinese for Voice Console calls", async () => {
    const hook = await mountSubmitHook();
    const audio = new Blob(["spoken audio"], { type: "audio/webm" });

    await act(async () => {
      await hook.current.submitRecordedUtterance({
        audio,
        sessionId: activeSession.id,
        mimeType: "audio/webm",
        originalName: "call.webm",
        durationMs: 1200,
      });
    });

    expect(submitRecordedCallUtteranceMock).toHaveBeenCalledWith({
      sessionId: activeSession.id,
      audio,
      mimeType: "audio/webm",
      originalName: "call.webm",
      durationMs: 1200,
      language: "zh-CN",
      finalFragmentReason: undefined,
    });
  });

  it("starts a workspace-level call when no channel is selected", async () => {
    startCallSessionMock.mockResolvedValue(workspaceSession);
    const hook = await mountSubmitHook({
      channelId: null,
      surfaceSession: null,
      title: "Voice Console",
    });

    await act(async () => {
      await hook.current.start();
    });

    expect(startCallSessionMock).toHaveBeenCalledWith({
      channelId: null,
      threadRootId: null,
      title: "Voice Console",
      mode: "call",
      wakeWords: undefined,
    });
    expect(hook.current.session).toBe(workspaceSession);
    expect(hook.current.isLive).toBe(true);
  });

  it("does not reuse an active call session when the selected Voice mode changed", async () => {
    const hook = await mountSubmitHook({
      surfaceSession: {
        ...activeSession,
        mode: "call",
      },
      mode: "wake_word",
      wakeWords: "小美",
    });

    await act(async () => {
      await hook.current.start();
    });

    expect(startCallSessionMock).not.toHaveBeenCalled();
    expect(hook.current.error).toContain("does not match the selected mode");
  });

  it("routes call work cancellation through the active call session", async () => {
    const hook = await mountSubmitHook();

    await act(async () => {
      await hook.current.cancelWork("work-1");
    });

    expect(cancelCallDispatchWorkMock).toHaveBeenCalledWith({
      sessionId: activeSession.id,
      workItemId: "work-1",
      language: "zh-CN",
    });
    expect(hook.current.lastResult).toBe(submitResult);
    expect(hook.current.submitResults).toEqual([submitResult]);
  });

  it("routes pending confirmation controls through the active call session", async () => {
    const hook = await mountSubmitHook();

    await act(async () => {
      await hook.current.resolveConfirmation(" yes ");
    });

    expect(resolveCallDispatchConfirmationMock).toHaveBeenCalledWith({
      sessionId: activeSession.id,
      transcript: "yes",
      language: "zh-CN",
    });
    expect(hook.current.lastResult).toBe(submitResult);
    expect(hook.current.submitResults).toEqual([submitResult]);
  });

  it("routes typed utterances through the active call session", async () => {
    const hook = await mountSubmitHook();

    await act(async () => {
      await hook.current.submitTypedUtterance({ transcript: " simulate speech " });
    });

    expect(submitTypedCallUtteranceMock).toHaveBeenCalledWith({
      sessionId: activeSession.id,
      transcript: "simulate speech",
      language: "zh-CN",
    });
    expect(hook.current.lastResult).toBe(submitResult);
    expect(hook.current.submitResults).toEqual([submitResult]);
  });

  it("passes typed Voice thread reply roots to the submit command", async () => {
    const hook = await mountSubmitHook();

    await act(async () => {
      await hook.current.submitTypedUtterance({
        transcript: " continue in this thread ",
        threadRootUtteranceId: "utterance-root-1",
      });
    });

    expect(submitTypedCallUtteranceMock).toHaveBeenCalledWith({
      sessionId: activeSession.id,
      transcript: "continue in this thread",
      threadRootUtteranceId: "utterance-root-1",
      language: "zh-CN",
    });
  });
});
