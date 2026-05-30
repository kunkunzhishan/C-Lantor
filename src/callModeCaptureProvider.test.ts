import { describe, expect, it } from "vitest";
import {
  resolveCallCaptureProviderBoundary,
  type CallCaptureProviderEnvironment,
} from "./callModeCaptureProvider";
import {
  MEDIA_RECORDER_MAX_AUDIO_BYTES,
  MEDIA_RECORDER_MAX_DURATION_MS,
  mediaRecorderAudioFilename,
  validateMediaRecorderAudio,
} from "./mediaRecorderAudio";

const supportedEnvironment: CallCaptureProviderEnvironment = {
  hasWindow: true,
  hasMediaRecorder: true,
  hasGetUserMedia: true,
  isSecureContext: true,
  isTauri: true,
  supportedMimeType: "audio/webm",
};

describe("call capture provider boundary", () => {
  it("uses browser MediaRecorder capture with the call utterance submit STT boundary", () => {
    const boundary = resolveCallCaptureProviderBoundary(supportedEnvironment);

    expect(boundary).toMatchObject({
      id: "browser-media-recorder",
      supportStatus: "supported",
      permissionModel: "tauri-native-permission-plus-browser-capture",
      captureApi: "MediaRecorder",
      sttBoundary: "call_session_submit_utterance",
      segmentation: "live-utterance-segments",
      mimeType: "audio/webm",
      unavailableReason: null,
    });
  });

  it("falls back to browser permission mode outside Tauri", () => {
    const boundary = resolveCallCaptureProviderBoundary({
      ...supportedEnvironment,
      isTauri: false,
    });

    expect(boundary.permissionModel).toBe("browser-get-user-media");
  });

  it("marks insecure non-Tauri pages unsupported before capture starts", () => {
    const boundary = resolveCallCaptureProviderBoundary({
      ...supportedEnvironment,
      isSecureContext: false,
      isTauri: false,
    });

    expect(boundary.supportStatus).toBe("unsupported");
    expect(boundary.unavailableReason).toBe("Microphone capture requires HTTPS or localhost.");
  });

  it("keeps Tauri WebViews eligible even when window secure context is false", () => {
    const boundary = resolveCallCaptureProviderBoundary({
      ...supportedEnvironment,
      isSecureContext: false,
    });

    expect(boundary.supportStatus).toBe("supported");
  });

  it("uses the same recording limits and filename extension mapping as live Call Mode audio", () => {
    expect(MEDIA_RECORDER_MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024);
    expect(MEDIA_RECORDER_MAX_DURATION_MS).toBe(60_000);
    expect(mediaRecorderAudioFilename(
      "lantor-call",
      "audio/webm;codecs=opus",
      new Date("2026-05-24T00:00:00.000Z"),
    )).toBe("lantor-call-2026-05-24T00-00-00-000Z.webm");
    expect(mediaRecorderAudioFilename(
      "lantor-call",
      "audio/ogg;codecs=opus",
      new Date("2026-05-24T00:00:00.000Z"),
    )).toBe("lantor-call-2026-05-24T00-00-00-000Z.ogg");
  });

  it("validates live audio before crossing the call utterance submit boundary", () => {
    expect(validateMediaRecorderAudio(512, 1000, "Call utterance")).toEqual({ ok: true });
    expect(validateMediaRecorderAudio(0, 1000, "Call utterance")).toEqual({
      ok: false,
      reason: "empty",
      message: "No speech detected.",
    });
    expect(validateMediaRecorderAudio(512, MEDIA_RECORDER_MAX_DURATION_MS + 1001, "Call utterance")).toEqual({
      ok: false,
      reason: "too_long",
      message: "Call utterance is too long.",
    });
    expect(validateMediaRecorderAudio(MEDIA_RECORDER_MAX_AUDIO_BYTES + 1, 1000, "Call utterance")).toEqual({
      ok: false,
      reason: "too_large",
      message: "Call utterance is too large. Maximum size is 25 MB.",
    });
  });
});
