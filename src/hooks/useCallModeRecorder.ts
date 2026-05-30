import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MEDIA_RECORDER_MAX_AUDIO_BYTES,
  MEDIA_RECORDER_MAX_DURATION_MS,
  mediaRecorderAudioFilename,
  microphoneCaptureErrorMessage,
  stopMediaStream,
  supportedMediaRecorderAudioMimeType,
  validateMediaRecorderAudio,
} from "../mediaRecorderAudio";
import {
  requestCallCapturePermission,
  resolveCallCaptureProviderBoundary,
} from "../callModeCaptureProvider";
import type { CallUtteranceSubmitResult } from "../types";

export const CALL_MODE_LIVE_SEGMENT_MS = 45_000;
export const CALL_MODE_VAD_POLL_MS = 150;
export const CALL_MODE_VAD_SILENCE_MS = 2_200;
export const CALL_MODE_VAD_MIN_SPEECH_MS = 700;
export const CALL_MODE_VAD_MIN_SEGMENT_MS = 2_500;
export const CALL_MODE_VAD_PREROLL_MS = 3_000;
export const CALL_MODE_VAD_BASE_RMS_THRESHOLD = 0.018;
export const CALL_MODE_VAD_MAX_RMS_THRESHOLD = 0.03;
const CALL_MODE_VAD_NOISE_MULTIPLIER = 1.5;
const CALL_MODE_VAD_INITIAL_NOISE_FLOOR_RMS = CALL_MODE_VAD_BASE_RMS_THRESHOLD / CALL_MODE_VAD_NOISE_MULTIPLIER;

export type CallModeRecorderStatus = "idle" | "requesting" | "listening" | "muted" | "unsupported" | "error";
export type LiveCallSegmentStopIntent = "flush" | "cancel";
export type CallModeFinalFragmentReason = "mute" | "end_call";

type UseCallModeRecorderOptions = {
  liveSessionId: string | null;
  echoGateActive?: boolean;
  onSubmitAudio: (input: {
    audio: Blob;
    sessionId: string;
    mimeType: string;
    originalName: string;
    durationMs: number;
    finalFragmentReason?: CallModeFinalFragmentReason;
  }) => Promise<CallUtteranceSubmitResult | null>;
};

type ActiveLiveCapture = {
  recorder: MediaRecorder | null;
  stream: MediaStream;
  chunks: Blob[];
  sessionId: string;
  segmentId: number;
  segmentStartedAt: number;
  cancelled: boolean;
  segmentTimer: number | null;
  vadTimer: number | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  analyserBuffer: Uint8Array | null;
  vadAvailable: boolean;
  hasDetectedSpeech: boolean;
  speechStartedAt: number | null;
  lastVoiceAt: number | null;
  lastConfirmedVoiceAt: number | null;
  lastRms: number;
  noiseFloorRms: number;
  vadThreshold: number;
  mimeType: string;
  isStopping: boolean;
  isSegmentStopping: boolean;
  stopAfterCurrentSegmentStatus: CallModeRecorderStatus | null;
  stopAfterCurrentSegmentMessage: string;
  flushWaiters: Array<() => void>;
};

function recorderErrorMessage(event: Event) {
  return event instanceof ErrorEvent && event.error instanceof Error
    ? event.error.message
    : "Live call capture failed.";
}

function createAudioContext() {
  const AudioContextCtor = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AudioContextCtor ? new AudioContextCtor() : null;
}

function closeCallAudioMonitor(active: ActiveLiveCapture) {
  if (active.vadTimer !== null) {
    window.clearInterval(active.vadTimer);
    active.vadTimer = null;
  }
  const context = active.audioContext;
  active.audioContext = null;
  active.analyser = null;
  active.analyserBuffer = null;
  if (context && context.state !== "closed") {
    void context.close().catch(() => undefined);
  }
}

function currentRms(analyser: AnalyserNode, buffer: Uint8Array) {
  analyser.getByteTimeDomainData(buffer as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (const value of buffer) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / buffer.length);
}

export function canSubmitLiveCallSegment(
  recordingSessionId: string,
  liveSessionId: string | null,
  cancelled: boolean,
  segmentId: number,
  currentSegmentId: number,
) {
  return !cancelled
    && recordingSessionId.length > 0
    && recordingSessionId === liveSessionId
    && segmentId === currentSegmentId;
}

export function canSubmitStoppedLiveCallSegment(
  intent: LiveCallSegmentStopIntent,
  recordingSessionId: string,
  liveSessionId: string | null,
  cancelled: boolean,
  segmentId: number,
  currentSegmentId: number,
) {
  return intent === "flush"
    && canSubmitLiveCallSegment(recordingSessionId, liveSessionId, cancelled, segmentId, currentSegmentId);
}

export function shouldRestartLiveCallCaptureAfterStop(
  cancelled: boolean,
  stopAfterCurrentSegmentStatus: CallModeRecorderStatus | null,
) {
  return !cancelled && stopAfterCurrentSegmentStatus === null;
}

export function finalFragmentReasonForStop(
  stopAfterCurrentSegmentStatus: CallModeRecorderStatus | null,
): CallModeFinalFragmentReason | undefined {
  if (stopAfterCurrentSegmentStatus === "muted") return "mute";
  if (stopAfterCurrentSegmentStatus === "idle") return "end_call";
  return undefined;
}

export type CallModeVadSnapshot = {
  hasDetectedSpeech: boolean;
  speechStartedAt: number | null;
  lastVoiceAt: number | null;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function callModeVadThreshold(noiseFloorRms: number) {
  return clamp(
    Math.max(CALL_MODE_VAD_BASE_RMS_THRESHOLD, noiseFloorRms * CALL_MODE_VAD_NOISE_MULTIPLIER),
    CALL_MODE_VAD_BASE_RMS_THRESHOLD,
    CALL_MODE_VAD_MAX_RMS_THRESHOLD,
  );
}

export function nextCallModeNoiseFloorRms(
  noiseFloorRms: number,
  rms: number,
  {
    hasDetectedSpeech = false,
    threshold = callModeVadThreshold(noiseFloorRms),
  }: {
    hasDetectedSpeech?: boolean;
    threshold?: number;
  } = {},
) {
  if (hasDetectedSpeech) return noiseFloorRms;
  const maxNoiseSample = threshold * 0.9;
  if (rms > maxNoiseSample) return noiseFloorRms;
  const alpha = rms < noiseFloorRms ? 0.25 : 0.08;
  return noiseFloorRms + (rms - noiseFloorRms) * alpha;
}

export function nextCallModeVadSnapshot(
  snapshot: CallModeVadSnapshot,
  rms: number,
  now: number,
  {
    minSpeechMs = CALL_MODE_VAD_MIN_SPEECH_MS,
    silenceMs = CALL_MODE_VAD_SILENCE_MS,
    threshold = CALL_MODE_VAD_BASE_RMS_THRESHOLD,
  }: {
    minSpeechMs?: number;
    silenceMs?: number;
    threshold?: number;
  } = {},
): CallModeVadSnapshot {
  let { hasDetectedSpeech, speechStartedAt, lastVoiceAt } = snapshot;
  if (rms >= threshold) {
    if (speechStartedAt === null || (lastVoiceAt !== null && now - lastVoiceAt >= silenceMs)) {
      speechStartedAt = now;
    }
    lastVoiceAt = now;
    if (speechStartedAt !== null && now - speechStartedAt >= minSpeechMs) {
      hasDetectedSpeech = true;
    }
    return { hasDetectedSpeech, speechStartedAt, lastVoiceAt };
  }

  if (!hasDetectedSpeech && lastVoiceAt !== null && now - lastVoiceAt >= silenceMs) {
    speechStartedAt = null;
    lastVoiceAt = null;
  }
  return { hasDetectedSpeech, speechStartedAt, lastVoiceAt };
}

export function useCallModeRecorder({ liveSessionId, echoGateActive = false, onSubmitAudio }: UseCallModeRecorderOptions) {
  const boundary = useMemo(() => resolveCallCaptureProviderBoundary(), []);
  const captureRef = useRef<ActiveLiveCapture | null>(null);
  const captureGenerationRef = useRef(0);
  const liveSessionIdRef = useRef(liveSessionId);
  const echoGateActiveRef = useRef(echoGateActive);
  const onSubmitAudioRef = useRef(onSubmitAudio);
  const pendingSubmissionsRef = useRef<Set<Promise<void>>>(new Set());
  const suppressAutoStartRef = useRef(false);
  liveSessionIdRef.current = liveSessionId;
  const [status, setStatus] = useState<CallModeRecorderStatus>(() => boundary.supportStatus === "supported" ? "idle" : "unsupported");
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [lastAudioBytes, setLastAudioBytes] = useState<number | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [pendingSubmitCount, setPendingSubmitCount] = useState(0);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const isSupported = boundary.supportStatus === "supported";

  useEffect(() => {
    onSubmitAudioRef.current = onSubmitAudio;
  }, [onSubmitAudio]);

  useEffect(() => {
    echoGateActiveRef.current = echoGateActive;
    if (echoGateActive) setIsVoiceActive(false);
  }, [echoGateActive]);

  useEffect(() => {
    liveSessionIdRef.current = liveSessionId;
  }, [liveSessionId]);

  const waitForPendingSubmissions = useCallback(async () => {
    while (pendingSubmissionsRef.current.size > 0) {
      await Promise.all(Array.from(pendingSubmissionsRef.current));
    }
  }, []);

  const finishStoppedCapture = useCallback((active: ActiveLiveCapture, nextStatus: CallModeRecorderStatus, statusMessage: string) => {
    if (active.segmentTimer !== null) {
      window.clearTimeout(active.segmentTimer);
      active.segmentTimer = null;
    }
    closeCallAudioMonitor(active);
    active.recorder = null;
    if (captureRef.current === active) captureRef.current = null;
    stopMediaStream(active.stream);
    setRecordingStartedAt(null);
    setRecordingElapsedMs(0);
    setIsVoiceActive(false);
    if (!active.cancelled) {
      setStatus(nextStatus);
      setStatusMessage(statusMessage);
    }
    active.flushWaiters.splice(0).forEach((resolve) => resolve());
  }, []);

  const cancelActiveCapture = useCallback((nextStatus: CallModeRecorderStatus = isSupported ? "idle" : "unsupported") => {
    captureGenerationRef.current += 1;
    const active = captureRef.current;
    captureRef.current = null;
    if (active) {
      active.cancelled = true;
      if (active.segmentTimer !== null) window.clearTimeout(active.segmentTimer);
      closeCallAudioMonitor(active);
      if (active.recorder) {
        active.recorder.ondataavailable = null;
        active.recorder.onstop = null;
        active.recorder.onerror = null;
        if (active.recorder.state !== "inactive") active.recorder.stop();
      }
      stopMediaStream(active.stream);
      active.flushWaiters.splice(0).forEach((resolve) => resolve());
    }
    setRecordingStartedAt(null);
    setRecordingElapsedMs(0);
    setIsVoiceActive(false);
    setIsStopping(false);
    setStatus(nextStatus);
    setStatusMessage(nextStatus === "muted" ? "Microphone muted." : "");
  }, [isSupported]);

  const flushActiveCapture = useCallback(async (
    nextStatus: CallModeRecorderStatus = isSupported ? "idle" : "unsupported",
    stoppedMessage = "",
  ) => {
    setIsStopping(true);
    try {
      captureGenerationRef.current += 1;
      const active = captureRef.current;
      if (!active) {
        setRecordingStartedAt(null);
        setRecordingElapsedMs(0);
        setIsVoiceActive(false);
        setStatus(nextStatus);
        setStatusMessage(stoppedMessage);
        await waitForPendingSubmissions();
        return;
      }

      active.stopAfterCurrentSegmentStatus = nextStatus;
      active.stopAfterCurrentSegmentMessage = stoppedMessage;
      if (active.isStopping) {
        setRecordingStartedAt(null);
        setRecordingElapsedMs(0);
        setIsVoiceActive(false);
        setStatus(nextStatus);
        setStatusMessage(nextStatus === "muted" ? "Mic muted; sending last captured utterance..." : "Ending call; sending last captured utterance...");
        const stopped = new Promise<void>((resolve) => {
          active.flushWaiters.push(resolve);
        });
        await stopped;
        await waitForPendingSubmissions();
        return;
      }
      if (active.segmentTimer !== null) {
        window.clearTimeout(active.segmentTimer);
        active.segmentTimer = null;
      }
      setRecordingStartedAt(null);
      setRecordingElapsedMs(0);
      setIsVoiceActive(false);
      setStatus(nextStatus);
      setStatusMessage(nextStatus === "muted" ? "Mic muted; sending last captured utterance..." : "Ending call; sending last captured utterance...");

      const stopped = new Promise<void>((resolve) => {
        active.flushWaiters.push(resolve);
      });
      if (!active.recorder || active.recorder.state === "inactive") {
        finishStoppedCapture(active, nextStatus, stoppedMessage);
      } else {
        try {
          active.isStopping = true;
          active.isSegmentStopping = true;
          active.recorder.stop();
        } catch (err) {
          active.isStopping = false;
          active.isSegmentStopping = false;
          active.cancelled = true;
          setError(microphoneCaptureErrorMessage(err));
          setStatus("error");
          setStatusMessage("");
          finishStoppedCapture(active, nextStatus, stoppedMessage);
        }
      }
      await stopped;
      await waitForPendingSubmissions();
    } finally {
      setIsStopping(false);
    }
  }, [finishStoppedCapture, isSupported, waitForPendingSubmissions]);

  const submitSegment = useCallback((active: ActiveLiveCapture, segmentId: number, chunks: Blob[], durationMs: number) => {
    if (!canSubmitStoppedLiveCallSegment("flush", active.sessionId, liveSessionIdRef.current, active.cancelled, segmentId, active.segmentId)) {
      return Promise.resolve();
    }
    const recordedMimeType = active.mimeType || "application/octet-stream";
    const blob = new Blob(chunks, { type: recordedMimeType });
    setLastAudioBytes(blob.size);
    setLastDurationMs(durationMs);

    const validation = validateMediaRecorderAudio(blob.size, durationMs, "Call utterance");
    if (active.vadAvailable && !active.hasDetectedSpeech) {
      setStatusMessage("Listening...");
      return Promise.resolve();
    }
    if (!validation.ok && validation.reason === "empty") {
      setStatusMessage("Listening...");
      return Promise.resolve();
    }
    if (!validation.ok) {
      active.cancelled = true;
      captureRef.current = null;
      stopMediaStream(active.stream);
      setIsVoiceActive(false);
      setError(validation.message);
      setStatus("error");
      setStatusMessage("");
      return Promise.resolve();
    }

    setPendingSubmitCount((count) => count + 1);
    setStatusMessage(
      active.stopAfterCurrentSegmentStatus === "muted"
        ? "Mic muted; sending last captured utterance..."
        : active.stopAfterCurrentSegmentStatus === "idle"
        ? "Ending call; sending last captured utterance..."
        : "Listening; sending captured utterance...",
    );
    let submission: Promise<void>;
    try {
      submission = Promise.resolve(onSubmitAudioRef.current({
        audio: blob,
        sessionId: active.sessionId,
        durationMs,
        mimeType: recordedMimeType,
        originalName: mediaRecorderAudioFilename("lantor-call", recordedMimeType),
        finalFragmentReason: finalFragmentReasonForStop(active.stopAfterCurrentSegmentStatus),
      })).then((result) => {
        if (captureRef.current !== active || active.cancelled) return;
        setStatusMessage(result ? "Listening; utterance submitted." : "Listening; utterance was not submitted.");
      }).catch((err: unknown) => {
        if (captureRef.current !== active || active.cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatusMessage("Listening; captured utterance failed.");
      }).finally(() => {
        setPendingSubmitCount((count) => Math.max(0, count - 1));
      });
    } catch (err) {
      setPendingSubmitCount((count) => Math.max(0, count - 1));
      if (captureRef.current === active && !active.cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setStatusMessage("Listening; captured utterance failed.");
      }
      return Promise.resolve();
    }
    const trackedSubmission = submission.then(() => undefined);
    pendingSubmissionsRef.current.add(trackedSubmission);
    void trackedSubmission.finally(() => {
      pendingSubmissionsRef.current.delete(trackedSubmission);
    });
    return trackedSubmission;
  }, []);

  const startSegmentRef = useRef<((active: ActiveLiveCapture) => void) | null>(null);
  startSegmentRef.current = (active: ActiveLiveCapture) => {
    if (captureRef.current !== active || active.cancelled) return;
    if (!canSubmitLiveCallSegment(active.sessionId, liveSessionIdRef.current, false, active.segmentId, active.segmentId)) {
      cancelActiveCapture();
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = active.mimeType
        ? new MediaRecorder(active.stream, { mimeType: active.mimeType })
        : new MediaRecorder(active.stream);
    } catch (err) {
      active.cancelled = true;
      captureRef.current = null;
      stopMediaStream(active.stream);
      setRecordingStartedAt(null);
      setIsVoiceActive(false);
      setError(microphoneCaptureErrorMessage(err));
      setStatus("error");
      setStatusMessage("");
      return;
    }
    active.recorder = recorder;
    active.chunks = [];
    active.segmentId += 1;
    active.hasDetectedSpeech = false;
    active.speechStartedAt = null;
    active.lastVoiceAt = null;
    active.lastConfirmedVoiceAt = null;
    active.lastRms = 0;
    active.noiseFloorRms = CALL_MODE_VAD_INITIAL_NOISE_FLOOR_RMS;
    active.vadThreshold = CALL_MODE_VAD_BASE_RMS_THRESHOLD;
    setIsVoiceActive(false);
    const segmentId = active.segmentId;
    active.segmentStartedAt = Date.now();
    setRecordingStartedAt(null);
    setRecordingElapsedMs(0);

    recorder.ondataavailable = (event) => {
      if (captureRef.current !== active || active.segmentId !== segmentId) return;
      if (event.data.size <= 0) return;
      active.chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      if (captureRef.current !== active || active.segmentId !== segmentId) return;
      active.cancelled = true;
      captureRef.current = null;
      if (active.segmentTimer !== null) window.clearTimeout(active.segmentTimer);
      closeCallAudioMonitor(active);
      stopMediaStream(active.stream);
      setRecordingStartedAt(null);
      setIsVoiceActive(false);
      setError(recorderErrorMessage(event));
      setStatus("error");
      setStatusMessage("");
      active.flushWaiters.splice(0).forEach((resolve) => resolve());
    };
    recorder.onstop = () => {
      if (captureRef.current !== active || active.segmentId !== segmentId) return;
      if (active.segmentTimer !== null) {
        window.clearTimeout(active.segmentTimer);
        active.segmentTimer = null;
      }
      closeCallAudioMonitor(active);
      active.recorder = null;
      active.isSegmentStopping = false;
      const chunks = [...active.chunks];
      const durationMs = Date.now() - active.segmentStartedAt;
      setLastDurationMs(durationMs);
      const submitted = submitSegment(active, segmentId, chunks, durationMs);
      if (active.stopAfterCurrentSegmentStatus) {
        void submitted.finally(() => {
          finishStoppedCapture(active, active.stopAfterCurrentSegmentStatus ?? "idle", active.stopAfterCurrentSegmentMessage);
        });
      } else if (
        captureRef.current === active
        && shouldRestartLiveCallCaptureAfterStop(active.cancelled, active.stopAfterCurrentSegmentStatus)
      ) {
        startSegmentRef.current?.(active);
      }
    };

    const startRecorder = () => {
      if (
        captureRef.current !== active
        || active.segmentId !== segmentId
        || active.stopAfterCurrentSegmentStatus
        || active.isSegmentStopping
        || recorder.state !== "inactive"
      ) {
        return;
      }
      const startedAt = Date.now();
      try {
        recorder.start();
      } catch (err) {
        active.cancelled = true;
        captureRef.current = null;
        stopMediaStream(active.stream);
        setRecordingStartedAt(null);
        setIsVoiceActive(false);
        setError(microphoneCaptureErrorMessage(err));
        setStatus("error");
        setStatusMessage("");
        return;
      }
      active.segmentStartedAt = startedAt;
      setRecordingStartedAt(startedAt);
      setRecordingElapsedMs(0);
      active.segmentTimer = window.setTimeout(() => {
        if (captureRef.current !== active || active.segmentId !== segmentId || recorder.state === "inactive") return;
        active.isSegmentStopping = true;
        recorder.stop();
      }, Math.min(CALL_MODE_LIVE_SEGMENT_MS, MEDIA_RECORDER_MAX_DURATION_MS));
    };

    const audioContext = createAudioContext();
    if (audioContext) {
      try {
        const source = audioContext.createMediaStreamSource(active.stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        active.audioContext = audioContext;
        active.analyser = analyser;
        active.analyserBuffer = new Uint8Array(analyser.fftSize);
        active.vadAvailable = true;
        active.vadTimer = window.setInterval(() => {
          if (
            captureRef.current !== active
            || active.segmentId !== segmentId
            || !active.analyser
            || !active.analyserBuffer
          ) {
            return;
          }
          const now = Date.now();
          const rms = currentRms(active.analyser, active.analyserBuffer);
          active.lastRms = rms;
          if (echoGateActiveRef.current) {
            setIsVoiceActive(false);
            return;
          }
          active.noiseFloorRms = nextCallModeNoiseFloorRms(active.noiseFloorRms, rms, {
            hasDetectedSpeech: active.hasDetectedSpeech,
            threshold: active.vadThreshold,
          });
          active.vadThreshold = callModeVadThreshold(active.noiseFloorRms);
          const voiceActive = rms >= active.vadThreshold;
          setIsVoiceActive((current) => current === voiceActive ? current : voiceActive);
          const nextVad = nextCallModeVadSnapshot({
            hasDetectedSpeech: active.hasDetectedSpeech,
            speechStartedAt: active.speechStartedAt,
            lastVoiceAt: active.lastVoiceAt,
          }, rms, now, { threshold: active.vadThreshold });
          active.hasDetectedSpeech = nextVad.hasDetectedSpeech;
          active.speechStartedAt = nextVad.speechStartedAt;
          active.lastVoiceAt = nextVad.lastVoiceAt;
          if (active.hasDetectedSpeech && voiceActive) active.lastConfirmedVoiceAt = now;
          if (voiceActive) return;
          if (
            !active.hasDetectedSpeech
            && active.speechStartedAt === null
            && now - active.segmentStartedAt >= CALL_MODE_VAD_PREROLL_MS
            && recorder.state !== "inactive"
          ) {
            active.isSegmentStopping = true;
            recorder.stop();
            return;
          }
          if (
            active.hasDetectedSpeech
            && active.speechStartedAt !== null
            && active.lastVoiceAt !== null
            && now - active.speechStartedAt >= CALL_MODE_VAD_MIN_SPEECH_MS
            && now - active.lastVoiceAt >= CALL_MODE_VAD_SILENCE_MS
            && now - active.segmentStartedAt >= CALL_MODE_VAD_MIN_SEGMENT_MS
            && recorder.state !== "inactive"
          ) {
            active.isSegmentStopping = true;
            recorder.stop();
          }
        }, CALL_MODE_VAD_POLL_MS);
        startRecorder();
      } catch {
        active.vadAvailable = false;
        void audioContext.close().catch(() => undefined);
        startRecorder();
      }
    } else {
      startRecorder();
    }
    setStatus("listening");
    setStatusMessage("Listening...");
  };

  const start = useCallback(async () => {
    if (!isSupported) {
      setStatus("unsupported");
      setError(boundary.unavailableReason ?? "Audio recording is not supported in this WebView.");
      return;
    }
    const recordingSessionId = liveSessionIdRef.current;
    if (!recordingSessionId) {
      setStatus("idle");
      setStatusMessage("");
      return;
    }
    suppressAutoStartRef.current = false;
    cancelActiveCapture();
    setIsMuted(false);
    setIsStopping(false);
    setError(null);
    setLastAudioBytes(null);
    setLastDurationMs(null);
    setStatus("requesting");
    setStatusMessage("Requesting microphone...");
    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;

    try {
      const permission = await requestCallCapturePermission(boundary);
      if (!permission.granted) {
        throw new Error(permission.error ?? "Microphone permission is blocked.");
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          window.isSecureContext
            ? "Microphone capture is not available in this browser."
            : "Microphone recording requires HTTPS or localhost on mobile browsers.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (captureGenerationRef.current !== generation) {
        stopMediaStream(stream);
        return;
      }
      const mimeType = supportedMediaRecorderAudioMimeType();
      const active: ActiveLiveCapture = {
        recorder: null,
        stream,
        chunks: [],
        sessionId: recordingSessionId,
        segmentId: 0,
        segmentStartedAt: Date.now(),
        cancelled: false,
        segmentTimer: null,
        vadTimer: null,
        audioContext: null,
        analyser: null,
        analyserBuffer: null,
        vadAvailable: false,
        hasDetectedSpeech: false,
        speechStartedAt: null,
        lastVoiceAt: null,
        lastConfirmedVoiceAt: null,
        lastRms: 0,
        noiseFloorRms: CALL_MODE_VAD_INITIAL_NOISE_FLOOR_RMS,
        vadThreshold: CALL_MODE_VAD_BASE_RMS_THRESHOLD,
        mimeType,
        isStopping: false,
        isSegmentStopping: false,
        stopAfterCurrentSegmentStatus: null,
        stopAfterCurrentSegmentMessage: "",
        flushWaiters: [],
      };
      captureRef.current = active;
      startSegmentRef.current?.(active);
    } catch (err) {
      if (captureGenerationRef.current !== generation) return;
      setError(microphoneCaptureErrorMessage(err));
      setRecordingStartedAt(null);
      setIsVoiceActive(false);
      setStatus("error");
      setStatusMessage("");
    }
  }, [boundary, cancelActiveCapture, isSupported]);

  const mute = useCallback(() => {
    setIsMuted(true);
    void flushActiveCapture("muted", "Microphone muted.");
  }, [flushActiveCapture]);

  const unmute = useCallback(() => {
    suppressAutoStartRef.current = false;
    setIsMuted(false);
    void start();
  }, [start]);

  const flushAndStop = useCallback(async () => {
    suppressAutoStartRef.current = true;
    setIsMuted(false);
    await flushActiveCapture(isSupported ? "idle" : "unsupported", "");
  }, [flushActiveCapture, isSupported]);

  useEffect(() => {
    if (!liveSessionId) {
      suppressAutoStartRef.current = false;
      setIsMuted(false);
      cancelActiveCapture();
      return;
    }
    if (suppressAutoStartRef.current || !isSupported || isMuted || status !== "idle") return;
    void start();
  }, [cancelActiveCapture, echoGateActive, isMuted, isSupported, liveSessionId, start, status]);

  useEffect(() => {
    if (status !== "listening" || recordingStartedAt === null) return;
    const updateElapsed = () => setRecordingElapsedMs(Date.now() - recordingStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt, status]);

  useEffect(() => () => {
    cancelActiveCapture();
  }, [cancelActiveCapture]);

  return {
    cancel: cancelActiveCapture,
    error,
    flushAndStop,
    isListening: status === "listening",
    isMuted,
    isRecording: status === "listening",
    isRequestingPermission: status === "requesting",
    isStopping,
    isSupported,
    isVoiceActive,
    isSubmittingAudio: pendingSubmitCount > 0,
    lastAudioBytes,
    lastDurationMs,
    limits: {
      maxAudioBytes: MEDIA_RECORDER_MAX_AUDIO_BYTES,
      maxDurationMs: MEDIA_RECORDER_MAX_DURATION_MS,
      segmentMs: CALL_MODE_LIVE_SEGMENT_MS,
    },
    mute,
    pendingSubmitCount,
    recordingElapsedMs,
    recordingStartedAt,
    start,
    status,
    statusMessage,
    unmute,
  };
}
