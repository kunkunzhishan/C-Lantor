import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  transcribeVoiceAudio,
  VoiceTranscriptionClientError,
  type VoiceTranscriptionResult,
} from "../voiceTranscription";
import {
  MEDIA_RECORDER_MAX_AUDIO_BYTES,
  MEDIA_RECORDER_MAX_DURATION_MS,
  mediaRecorderAudioFilename,
  mediaRecorderAudioSupport,
  microphoneCaptureErrorMessage,
  stopMediaStream,
  supportedMediaRecorderAudioMimeType,
} from "../mediaRecorderAudio";

export type VoiceAgentRecorderStatus = "idle" | "requesting" | "recording" | "transcribing" | "unsupported" | "error";

export const VOICE_AGENT_MAX_AUDIO_BYTES = MEDIA_RECORDER_MAX_AUDIO_BYTES;
export const VOICE_AGENT_MAX_DURATION_MS = MEDIA_RECORDER_MAX_DURATION_MS;

type UseVoiceAgentRecorderOptions = {
  language?: string;
  onTranscript: (result: VoiceTranscriptionResult) => void;
};

type ActiveRecording = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  cancelled: boolean;
  maxDurationTimer: number | null;
};

function recorderFilename(mimeType: string) {
  return mediaRecorderAudioFilename("lantor-voice", mimeType);
}

function voiceRecorderError(message: string, code: string) {
  return new VoiceTranscriptionClientError(message, { code });
}

export function useVoiceAgentRecorder({
  language = "zh-CN",
  onTranscript,
}: UseVoiceAgentRecorderOptions) {
  const recordingRef = useRef<ActiveRecording | null>(null);
  const sessionIdRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  const [status, setStatus] = useState<VoiceAgentRecorderStatus>(() => mediaRecorderAudioSupport() ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [lastResult, setLastResult] = useState<VoiceTranscriptionResult | null>(null);
  const [lastAudioBytes, setLastAudioBytes] = useState<number | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const isSupported = useMemo(() => mediaRecorderAudioSupport(), []);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const resetToIdle = useCallback(() => {
    setStatus(isSupported ? "idle" : "unsupported");
    setStatusMessage("");
  }, [isSupported]);

  const cancel = useCallback(() => {
    sessionIdRef.current += 1;
    const active = recordingRef.current;
    recordingRef.current = null;
    if (!active) {
      setRecordingStartedAt(null);
      setRecordingElapsedMs(0);
      resetToIdle();
      return;
    }
    active.cancelled = true;
    active.recorder.ondataavailable = null;
    active.recorder.onstop = null;
    active.recorder.onerror = null;
    if (active.maxDurationTimer !== null) window.clearTimeout(active.maxDurationTimer);
    if (active.recorder.state !== "inactive") active.recorder.stop();
    stopMediaStream(active.stream);
    setRecordingStartedAt(null);
    setRecordingElapsedMs(0);
    resetToIdle();
  }, [resetToIdle]);

  const stop = useCallback(() => {
    const active = recordingRef.current;
    if (!active || active.recorder.state === "inactive") return;
    setStatusMessage("Transcribing voice...");
    setStatus("transcribing");
    active.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (!isSupported) {
      setStatus("unsupported");
      setError("Audio recording is not supported in this WebView.");
      setErrorCode("unsupportedRecorder");
      return;
    }
    cancel();
    setError(null);
    setErrorCode(null);
    setLastResult(null);
    setLastAudioBytes(null);
    setLastDurationMs(null);
    setStatus("requesting");
    setStatusMessage("Requesting microphone...");
    const sessionId = sessionIdRef.current + 1;
    sessionIdRef.current = sessionId;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw voiceRecorderError(
          window.isSecureContext
            ? "Microphone capture is not available in this browser."
            : "Microphone recording requires HTTPS or localhost on mobile browsers.",
          "microphoneRequiresSecureContext",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionIdRef.current !== sessionId) {
        stopMediaStream(stream);
        return;
      }
      const mimeType = supportedMediaRecorderAudioMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const startedAt = Date.now();
      const active: ActiveRecording = {
        recorder,
        stream,
        chunks: [],
        startedAt,
        cancelled: false,
        maxDurationTimer: null,
      };
      recordingRef.current = active;
      setRecordingStartedAt(startedAt);
      setRecordingElapsedMs(0);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) active.chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        if (sessionIdRef.current !== sessionId) return;
        const message = event instanceof ErrorEvent && event.error instanceof Error
          ? event.error.message
          : "Voice recording failed.";
        active.cancelled = true;
        recordingRef.current = null;
        if (active.maxDurationTimer !== null) window.clearTimeout(active.maxDurationTimer);
        stopMediaStream(stream);
        setRecordingStartedAt(null);
        setError(message);
        setErrorCode("recordingFailed");
        setStatus("error");
        setStatusMessage("");
      };
      recorder.onstop = () => {
        if (recordingRef.current === active) recordingRef.current = null;
        if (active.maxDurationTimer !== null) window.clearTimeout(active.maxDurationTimer);
        stopMediaStream(stream);
        if (active.cancelled || sessionIdRef.current !== sessionId) return;
        const durationMs = Date.now() - active.startedAt;
        setRecordingStartedAt(null);
        setRecordingElapsedMs(durationMs);
        const recordedMimeType = recorder.mimeType || mimeType || "application/octet-stream";
        const blob = new Blob(active.chunks, { type: recordedMimeType });
        setLastAudioBytes(blob.size);
        setLastDurationMs(durationMs);
        if (blob.size === 0) {
          setStatus("idle");
          setStatusMessage("No speech detected.");
          setError(null);
          setErrorCode(null);
          return;
        }
        if (durationMs > VOICE_AGENT_MAX_DURATION_MS + 1000) {
          setError("Voice recording is too long.");
          setErrorCode("recordingTooLong");
          setStatus("error");
          setStatusMessage("");
          return;
        }
        if (blob.size > VOICE_AGENT_MAX_AUDIO_BYTES) {
          setError(`Voice audio is too large. Maximum size is ${Math.floor(VOICE_AGENT_MAX_AUDIO_BYTES / 1024 / 1024)} MB.`);
          setErrorCode("audioTooLarge");
          setStatus("error");
          setStatusMessage("");
          return;
        }
        void transcribeVoiceAudio({
          audio: blob,
          durationMs,
          filename: recorderFilename(recordedMimeType),
          language,
          mimeType: recordedMimeType,
        }).then((result) => {
          if (sessionIdRef.current !== sessionId) return;
          setLastResult(result);
          setStatusMessage("");
          setStatus("idle");
          onTranscriptRef.current(result);
        }).catch((err: unknown) => {
          if (sessionIdRef.current !== sessionId) return;
          const normalized = err instanceof VoiceTranscriptionClientError
            ? err
            : voiceRecorderError(err instanceof Error ? err.message : "Voice transcription failed.", "transcriptionFailed");
          if (normalized.code === "emptyTranscript" || normalized.code === "emptyAudio") {
            setStatus("idle");
            setStatusMessage("No speech detected.");
            setError(null);
            setErrorCode(null);
            return;
          }
          setError(normalized.message);
          setErrorCode(normalized.code);
          setStatus("error");
          setStatusMessage("");
        });
      };

      recorder.start();
      active.maxDurationTimer = window.setTimeout(() => {
        if (recordingRef.current !== active || active.recorder.state === "inactive") return;
        setStatusMessage("Transcribing voice...");
        setStatus("transcribing");
        active.recorder.stop();
      }, VOICE_AGENT_MAX_DURATION_MS);
      setStatus("recording");
      setStatusMessage("Listening...");
    } catch (err) {
      if (sessionIdRef.current !== sessionId) return;
      const normalized = err instanceof VoiceTranscriptionClientError
        ? err
        : voiceRecorderError(microphoneCaptureErrorMessage(err), "microphoneUnavailable");
      setError(normalized.message);
      setErrorCode(normalized.code);
      setRecordingStartedAt(null);
      setStatus("error");
      setStatusMessage("");
    }
  }, [cancel, isSupported, language]);

  useEffect(() => {
    if (status !== "recording" || recordingStartedAt === null) return;
    const updateElapsed = () => setRecordingElapsedMs(Date.now() - recordingStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt, status]);

  useEffect(() => () => {
    cancel();
  }, [cancel]);

  return {
    cancel,
    error,
    errorCode,
    isRecording: status === "recording",
    isRequestingPermission: status === "requesting",
    isSupported,
    isTranscribing: status === "transcribing",
    lastAudioBytes,
    lastDurationMs,
    lastResult,
    limits: {
      maxAudioBytes: VOICE_AGENT_MAX_AUDIO_BYTES,
      maxDurationMs: VOICE_AGENT_MAX_DURATION_MS,
    },
    recordingElapsedMs,
    recordingStartedAt,
    start,
    status,
    statusMessage,
    stop,
  };
}
