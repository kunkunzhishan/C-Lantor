export const MEDIA_RECORDER_AUDIO_MIME_TYPES = [
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export const MEDIA_RECORDER_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MEDIA_RECORDER_MAX_DURATION_MS = 60_000;

export type MediaRecorderAudioValidation =
  | { ok: true }
  | { ok: false; reason: "empty" | "too_long" | "too_large"; message: string };

export function mediaRecorderAudioSupport() {
  return typeof window !== "undefined"
    && typeof MediaRecorder !== "undefined";
}

export function supportedMediaRecorderAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return MEDIA_RECORDER_AUDIO_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

export function mediaRecorderAudioFilename(
  prefix: string,
  mimeType: string,
  now: Date = new Date(),
) {
  const extension = mimeType.includes("mp4") || mimeType.includes("aac")
    ? "m4a"
    : mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("wav")
    ? "wav"
    : "webm";
  return `${prefix}-${now.toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

export function microphoneCaptureErrorMessage(err: unknown) {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") return "Microphone permission is blocked.";
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") return "No microphone was found.";
    if (err.name === "NotReadableError" || err.name === "TrackStartError") return "Microphone is already in use.";
  }
  return err instanceof Error ? err.message : "Microphone capture could not start.";
}

export function validateMediaRecorderAudio(
  audioBytes: number,
  durationMs: number,
  label: string,
): MediaRecorderAudioValidation {
  if (audioBytes === 0) {
    return { ok: false, reason: "empty", message: "No speech detected." };
  }
  if (durationMs > MEDIA_RECORDER_MAX_DURATION_MS + 1000) {
    return { ok: false, reason: "too_long", message: `${label} is too long.` };
  }
  if (audioBytes > MEDIA_RECORDER_MAX_AUDIO_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      message: `${label} is too large. Maximum size is ${Math.floor(MEDIA_RECORDER_MAX_AUDIO_BYTES / 1024 / 1024)} MB.`,
    };
  }
  return { ok: true };
}

export function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}
