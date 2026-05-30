import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiInvoke } from "./apiClient";
import {
  bytesFromBlob,
  cancelCallDispatchWork,
  resolveCallDispatchConfirmation,
  submitRecordedCallUtterance,
  submitTypedCallUtterance,
} from "./callModeClient";
import type { CallUtteranceSubmitResult } from "./types";

vi.mock("./apiClient", () => ({
  apiInvoke: vi.fn(),
}));

const apiInvokeMock = vi.mocked(apiInvoke);

function submitResult(): CallUtteranceSubmitResult {
  return {
    session: {
      id: "call-session-1",
      channel_id: "channel-1",
      thread_root_id: null,
      status: "active",
      title: "Call",
      started_at: "2026-05-24T00:00:00.000Z",
      ended_at: null,
      updated_at: "2026-05-24T00:00:02.000Z",
    },
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
      audio_duration_ms: 1250,
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
}

describe("callModeClient audio submit", () => {
  beforeEach(() => {
    apiInvokeMock.mockReset();
  });

  it("converts live audio blobs to backend utterance bytes", async () => {
    const result = submitResult();
    apiInvokeMock.mockResolvedValue(result);
    const blob = new Blob([new Uint8Array([3, 5, 8, 13])], { type: "audio/webm" });

    await expect(submitRecordedCallUtterance({
      sessionId: "call-session-1",
      audio: blob,
      originalName: "call.webm",
      durationMs: 1249.6,
      language: "zh-CN",
      finalFragmentReason: "mute",
    })).resolves.toBe(result);

    expect(apiInvokeMock).toHaveBeenCalledWith("call_session_submit_utterance", {
      sessionId: "call-session-1",
      bytes: [3, 5, 8, 13],
      mimeType: "audio/webm",
      originalName: "call.webm",
      durationMs: 1250,
      language: "zh-CN",
      finalFragmentReason: "mute",
    });
  });

  it("keeps blob byte order stable for binary audio", async () => {
    await expect(bytesFromBlob(new Blob([new Uint8Array([0, 255, 128])]))).resolves.toEqual([0, 255, 128]);
  });

  it("sends call-scoped work cancellation through the call dispatch command", async () => {
    const result = submitResult();
    apiInvokeMock.mockResolvedValue(result);

    await expect(cancelCallDispatchWork({
      sessionId: "call-session-1",
      workItemId: "work-1",
    })).resolves.toBe(result);

    expect(apiInvokeMock).toHaveBeenCalledWith("call_dispatch_cancel_work", {
      sessionId: "call-session-1",
      workItemId: "work-1",
    });
  });

  it("sends call confirmation responses through the call-control command", async () => {
    const result = submitResult();
    apiInvokeMock.mockResolvedValue(result);

    await expect(resolveCallDispatchConfirmation({
      sessionId: "call-session-1",
      transcript: " yes ",
    })).resolves.toBe(result);

    expect(apiInvokeMock).toHaveBeenCalledWith("call_dispatch_resolve_confirmation", {
      sessionId: "call-session-1",
      transcript: "yes",
    });
  });

  it("sends typed call utterances through the text submit command", async () => {
    const result = submitResult();
    apiInvokeMock.mockResolvedValue(result);

    await expect(submitTypedCallUtterance({
      sessionId: "call-session-1",
      transcript: " pretend I said this ",
    })).resolves.toBe(result);

    expect(apiInvokeMock).toHaveBeenCalledWith("call_session_submit_text_utterance", {
      sessionId: "call-session-1",
      transcript: "pretend I said this",
    });
  });

  it("sends typed Voice thread replies with their thread root", async () => {
    const result = submitResult();
    apiInvokeMock.mockResolvedValue(result);

    await expect(submitTypedCallUtterance({
      sessionId: "call-session-1",
      transcript: " continue that ",
      threadRootUtteranceId: "utterance-root-1",
    })).resolves.toBe(result);

    expect(apiInvokeMock).toHaveBeenCalledWith("call_session_submit_text_utterance", {
      sessionId: "call-session-1",
      transcript: "continue that",
      threadRootUtteranceId: "utterance-root-1",
    });
  });
});
