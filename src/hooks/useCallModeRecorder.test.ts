import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CallUtteranceSubmitResult } from "../types";
import {
  CALL_MODE_LIVE_SEGMENT_MS,
  CALL_MODE_VAD_BASE_RMS_THRESHOLD,
  CALL_MODE_VAD_MAX_RMS_THRESHOLD,
  CALL_MODE_VAD_MIN_SEGMENT_MS,
  CALL_MODE_VAD_MIN_SPEECH_MS,
  CALL_MODE_VAD_POLL_MS,
  CALL_MODE_VAD_PREROLL_MS,
  CALL_MODE_VAD_SILENCE_MS,
  type CallModeVadSnapshot,
  callModeVadThreshold,
  canSubmitLiveCallSegment,
  canSubmitStoppedLiveCallSegment,
  finalFragmentReasonForStop,
  nextCallModeNoiseFloorRms,
  nextCallModeVadSnapshot,
  shouldRestartLiveCallCaptureAfterStop,
  useCallModeRecorder,
} from "./useCallModeRecorder";

type RecorderHookValue = ReturnType<typeof useCallModeRecorder>;
type SubmitAudio = Parameters<typeof useCallModeRecorder>[0]["onSubmitAudio"];
type FakeTrack = { stop: Mock };
type FakeStream = MediaStream & { tracks: FakeTrack[] };

let latestRecorderHook: RecorderHookValue | null = null;
let currentRenderer: ReactTestRenderer | null = null;
let getUserMediaMock: Mock<() => Promise<MediaStream>>;
let issuedStreams: FakeStream[] = [];
let fakeAudioRms = 0;

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalMediaRecorder = globalThis.MediaRecorder;
const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createFakeStream(): FakeStream {
  const tracks = [{ stop: vi.fn() }];
  return {
    getTracks: () => tracks,
    tracks,
  } as unknown as FakeStream;
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mimeType: string) => mimeType === "audio/webm");

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  state: RecordingState = "inactive";
  stopCalls = 0;
  startTimeslice: number | undefined;

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number) {
    this.startTimeslice = timeslice;
    this.state = "recording";
  }

  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
  }

  finishStop(data = new Blob(["spoken audio"], { type: "audio/webm" })) {
    this.ondataavailable?.({ data } as BlobEvent);
    this.onstop?.(new Event("stop"));
  }

  emitData(data = new Blob(["preroll audio"], { type: "audio/webm" })) {
    this.ondataavailable?.({ data } as BlobEvent);
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";

  createMediaStreamSource() {
    return { connect: vi.fn() };
  }

  createAnalyser() {
    return {
      fftSize: 1024,
      getByteTimeDomainData: (buffer: Uint8Array) => {
        const value = Math.max(0, Math.min(255, Math.round(128 + fakeAudioRms * 128)));
        buffer.fill(value);
      },
    };
  }

  close = vi.fn(async () => {
    this.state = "closed";
  });
}

function RecorderProbe({
  echoGateActive = false,
  liveSessionId,
  onSubmitAudio,
}: {
  echoGateActive?: boolean;
  liveSessionId: string | null;
  onSubmitAudio: SubmitAudio;
}) {
  latestRecorderHook = useCallModeRecorder({ echoGateActive, liveSessionId, onSubmitAudio });
  return null;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountRecorder({
  echoGateActive = false,
  liveSessionId = "call-session-1",
  onSubmitAudio = vi.fn(async () => null),
}: {
  echoGateActive?: boolean;
  liveSessionId?: string | null;
  onSubmitAudio?: SubmitAudio;
} = {}) {
  await act(async () => {
    currentRenderer = create(React.createElement(RecorderProbe, { echoGateActive, liveSessionId, onSubmitAudio }));
  });
  await flushReact();

  return {
    get current() {
      if (!latestRecorderHook) throw new Error("Recorder hook was not mounted.");
      return latestRecorderHook;
    },
    async update(
      nextLiveSessionId: string | null,
      nextSubmitAudio: SubmitAudio = onSubmitAudio,
      nextEchoGateActive = echoGateActive,
    ) {
      if (!currentRenderer) throw new Error("Recorder hook was not mounted.");
      await act(async () => {
        currentRenderer?.update(React.createElement(RecorderProbe, {
          echoGateActive: nextEchoGateActive,
          liveSessionId: nextLiveSessionId,
          onSubmitAudio: nextSubmitAudio,
        }));
      });
      await flushReact();
    },
  };
}

describe("call mode recorder lifecycle helpers", () => {
  it("submits live microphone segments only for the current active call", () => {
    expect(canSubmitLiveCallSegment("call-session-1", "call-session-1", false, 2, 2)).toBe(true);
    expect(canSubmitLiveCallSegment("call-session-1", "call-session-2", false, 2, 2)).toBe(false);
    expect(canSubmitLiveCallSegment("call-session-1", null, false, 2, 2)).toBe(false);
    expect(canSubmitLiveCallSegment("call-session-1", "call-session-1", true, 2, 2)).toBe(false);
    expect(canSubmitLiveCallSegment("call-session-1", "call-session-1", false, 1, 2)).toBe(false);
  });

  it("uses conservative live segments instead of per-short-pause commits", () => {
    expect(CALL_MODE_LIVE_SEGMENT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CALL_MODE_LIVE_SEGMENT_MS).toBeLessThanOrEqual(60_000);
  });

  it("flushes the active recorder segment for mute or end-call stops", () => {
    expect(canSubmitStoppedLiveCallSegment("flush", "call-session-1", "call-session-1", false, 2, 2)).toBe(true);
    expect(canSubmitStoppedLiveCallSegment("flush", "call-session-1", "call-session-2", false, 2, 2)).toBe(false);
    expect(canSubmitStoppedLiveCallSegment("flush", "call-session-1", null, false, 2, 2)).toBe(false);
    expect(canSubmitStoppedLiveCallSegment("flush", "call-session-1", "call-session-1", true, 2, 2)).toBe(false);
    expect(canSubmitStoppedLiveCallSegment("flush", "call-session-1", "call-session-1", false, 1, 2)).toBe(false);
  });

  it("preserves true cancel cleanup as non-submitting", () => {
    expect(canSubmitStoppedLiveCallSegment("cancel", "call-session-1", "call-session-1", false, 2, 2)).toBe(false);
  });

  it("restarts only after ordinary live segment rotation", () => {
    expect(shouldRestartLiveCallCaptureAfterStop(false, null)).toBe(true);
    expect(shouldRestartLiveCallCaptureAfterStop(false, "muted")).toBe(false);
    expect(shouldRestartLiveCallCaptureAfterStop(false, "idle")).toBe(false);
    expect(shouldRestartLiveCallCaptureAfterStop(true, null)).toBe(false);
  });

  it("marks only mute and end-call stops as final fragments", () => {
    expect(finalFragmentReasonForStop("muted")).toBe("mute");
    expect(finalFragmentReasonForStop("idle")).toBe("end_call");
    expect(finalFragmentReasonForStop(null)).toBeUndefined();
    expect(finalFragmentReasonForStop("listening")).toBeUndefined();
  });

  it("requires sustained voice before a live segment is considered speech", () => {
    const options = {
      minSpeechMs: CALL_MODE_VAD_MIN_SPEECH_MS,
      silenceMs: CALL_MODE_VAD_SILENCE_MS,
      threshold: 0.018,
    };
    let vad: CallModeVadSnapshot = { hasDetectedSpeech: false, speechStartedAt: null, lastVoiceAt: null };

    vad = nextCallModeVadSnapshot(vad, 0.03, 0, options);
    expect(vad.hasDetectedSpeech).toBe(false);
    vad = nextCallModeVadSnapshot(vad, 0.001, CALL_MODE_VAD_SILENCE_MS - 150, options);
    expect(vad).toMatchObject({
      hasDetectedSpeech: false,
      speechStartedAt: 0,
      lastVoiceAt: 0,
    });
    vad = nextCallModeVadSnapshot(vad, 0.001, CALL_MODE_VAD_SILENCE_MS + 150, options);
    expect(vad).toMatchObject({
      hasDetectedSpeech: false,
      speechStartedAt: null,
      lastVoiceAt: null,
    });

    vad = nextCallModeVadSnapshot(vad, 0.03, 3000, options);
    vad = nextCallModeVadSnapshot(vad, 0.03, 3000 + CALL_MODE_VAD_MIN_SPEECH_MS - 150, options);
    expect(vad.hasDetectedSpeech).toBe(false);
    vad = nextCallModeVadSnapshot(vad, 0.03, 3000 + CALL_MODE_VAD_MIN_SPEECH_MS + 50, options);
    expect(vad.hasDetectedSpeech).toBe(true);
  });

  it("raises the VAD threshold with the measured noise floor while keeping hard bounds", () => {
    const quietThreshold = callModeVadThreshold(0.001);
    const noisyThreshold = callModeVadThreshold(0.02);
    const clippedThreshold = callModeVadThreshold(1);

    expect(quietThreshold).toBe(CALL_MODE_VAD_BASE_RMS_THRESHOLD);
    expect(noisyThreshold).toBeGreaterThan(CALL_MODE_VAD_BASE_RMS_THRESHOLD);
    expect(clippedThreshold).toBe(CALL_MODE_VAD_MAX_RMS_THRESHOLD);

    const learnedNoise = nextCallModeNoiseFloorRms(0.01, 0.014, { threshold: CALL_MODE_VAD_BASE_RMS_THRESHOLD });
    expect(learnedNoise).toBeGreaterThan(0.01);
    expect(nextCallModeNoiseFloorRms(learnedNoise, 0.02, { threshold: CALL_MODE_VAD_BASE_RMS_THRESHOLD }))
      .toBe(learnedNoise);
    expect(nextCallModeNoiseFloorRms(learnedNoise, 0.001, { hasDetectedSpeech: true }))
      .toBe(learnedNoise);
  });
});

describe("useCallModeRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    issuedStreams = [];
    fakeAudioRms = 0;
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.isTypeSupported.mockClear();
    latestRecorderHook = null;
    currentRenderer = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    getUserMediaMock = vi.fn(async () => {
      const stream = createFakeStream();
      issuedStreams.push(stream);
      return stream;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
        isSecureContext: true,
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: getUserMediaMock,
        },
      },
    });
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: FakeMediaRecorder,
    });
  });

  afterEach(async () => {
    if (currentRenderer) {
      await act(async () => {
        currentRenderer?.unmount();
      });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalNavigator === undefined) delete (globalThis as Partial<typeof globalThis>).navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
    if (originalMediaRecorder === undefined) delete (globalThis as Partial<typeof globalThis>).MediaRecorder;
    else Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: originalMediaRecorder });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("rotates live microphone segments and restarts capture without a commit action", async () => {
    const onSubmitAudio = vi.fn<SubmitAudio>(async () => null);
    const recorder = await mountRecorder({ onSubmitAudio });

    expect(recorder.current.status).toBe("listening");
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(issuedStreams[0].tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_LIVE_SEGMENT_MS);
    });
    expect(FakeMediaRecorder.instances[0].stopCalls).toBe(1);

    await act(async () => {
      FakeMediaRecorder.instances[0].finishStop();
      await Promise.resolve();
    });
    await flushReact();

    expect(onSubmitAudio).toHaveBeenCalledTimes(1);
    expect(onSubmitAudio.mock.calls[0][0]).toMatchObject({
      durationMs: CALL_MODE_LIVE_SEGMENT_MS,
      mimeType: "audio/webm",
      sessionId: "call-session-1",
    });
    expect(onSubmitAudio.mock.calls[0][0].finalFragmentReason).toBeUndefined();
    expect(recorder.current.status).toBe("listening");
    expect(recorder.current.pendingSubmitCount).toBe(0);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it("keeps bounded VAD pre-roll so first words are not clipped without submitting long idle audio", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
        isSecureContext: true,
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
      },
    });
    const onSubmitAudio = vi.fn<SubmitAudio>(async () => null);
    const recorder = await mountRecorder({ onSubmitAudio });
    const idleRecorder = FakeMediaRecorder.instances[0];

    expect(recorder.current.status).toBe("listening");
    expect(idleRecorder.state).toBe("recording");
    expect(idleRecorder.startTimeslice).toBeUndefined();
    expect(recorder.current.recordingStartedAt).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_VAD_PREROLL_MS + CALL_MODE_VAD_POLL_MS);
    });

    expect(idleRecorder.stopCalls).toBe(1);
    await act(async () => {
      idleRecorder.finishStop();
      await Promise.resolve();
    });
    await flushReact();

    expect(onSubmitAudio).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    const activeRecorder = FakeMediaRecorder.instances[1];
    expect(activeRecorder.state).toBe("recording");
    expect(activeRecorder.stopCalls).toBe(0);

    fakeAudioRms = 0.03;
    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_VAD_POLL_MS);
    });

    expect(activeRecorder.state).toBe("recording");

    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_VAD_MIN_SPEECH_MS + CALL_MODE_VAD_POLL_MS);
    });
    fakeAudioRms = 0;
    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_VAD_SILENCE_MS + CALL_MODE_VAD_MIN_SEGMENT_MS);
    });

    expect(activeRecorder.stopCalls).toBe(1);

    await act(async () => {
      activeRecorder.finishStop();
      await Promise.resolve();
    });
    await flushReact();

    expect(onSubmitAudio).toHaveBeenCalledTimes(1);
    expect(onSubmitAudio.mock.calls[0][0].durationMs).toBeLessThan(
      CALL_MODE_VAD_PREROLL_MS + CALL_MODE_VAD_MIN_SPEECH_MS + CALL_MODE_VAD_SILENCE_MS + CALL_MODE_VAD_MIN_SEGMENT_MS + 500,
    );
  });

  it("flushes the active segment on mute and waits for the submit lifecycle to finish cleanup", async () => {
    const submitDeferred = createDeferred<CallUtteranceSubmitResult | null>();
    const onSubmitAudio = vi.fn<SubmitAudio>(() => submitDeferred.promise);
    const recorder = await mountRecorder({ onSubmitAudio });
    const activeCaptureStream = issuedStreams[1];
    const activeRecorder = FakeMediaRecorder.instances[0];

    await act(async () => {
      recorder.current.mute();
      await Promise.resolve();
    });

    expect(recorder.current.isStopping).toBe(true);
    expect(recorder.current.isMuted).toBe(true);
    expect(recorder.current.status).toBe("muted");
    expect(activeRecorder.stopCalls).toBe(1);
    expect(activeCaptureStream.tracks[0].stop).not.toHaveBeenCalled();

    await act(async () => {
      activeRecorder.finishStop();
      await Promise.resolve();
    });

    expect(onSubmitAudio).toHaveBeenCalledTimes(1);
    expect(onSubmitAudio.mock.calls[0][0].finalFragmentReason).toBe("mute");
    expect(recorder.current.pendingSubmitCount).toBe(1);

    await act(async () => {
      submitDeferred.resolve(null);
      await submitDeferred.promise;
    });
    await flushReact();

    expect(recorder.current.status).toBe("muted");
    expect(recorder.current.isStopping).toBe(false);
    expect(recorder.current.pendingSubmitCount).toBe(0);
    expect(activeCaptureStream.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("joins duplicate end-call flushes to the same final recorder stop and submit", async () => {
    const submitDeferred = createDeferred<CallUtteranceSubmitResult | null>();
    const onSubmitAudio = vi.fn<SubmitAudio>(() => submitDeferred.promise);
    const recorder = await mountRecorder({ onSubmitAudio });
    const activeRecorder = FakeMediaRecorder.instances[0];
    let firstStop!: Promise<void>;
    let secondStop!: Promise<void>;

    await act(async () => {
      firstStop = recorder.current.flushAndStop();
      secondStop = recorder.current.flushAndStop();
      await Promise.resolve();
    });

    expect(activeRecorder.stopCalls).toBe(1);
    expect(recorder.current.isStopping).toBe(true);
    expect(recorder.current.status).toBe("idle");
    expect(onSubmitAudio).not.toHaveBeenCalled();

    await act(async () => {
      activeRecorder.finishStop();
      await Promise.resolve();
    });

    expect(onSubmitAudio).toHaveBeenCalledTimes(1);
    expect(onSubmitAudio.mock.calls[0][0].finalFragmentReason).toBe("end_call");
    expect(recorder.current.pendingSubmitCount).toBe(1);

    await act(async () => {
      submitDeferred.resolve(null);
      await Promise.all([submitDeferred.promise, firstStop, secondStop]);
    });
    await flushReact();

    expect(recorder.current.status).toBe("idle");
    expect(recorder.current.isStopping).toBe(false);
    expect(recorder.current.pendingSubmitCount).toBe(0);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("drops stale active-session audio and stops the old stream when the live session changes", async () => {
    const onSubmitAudio = vi.fn(async () => null);
    const recorder = await mountRecorder({ onSubmitAudio });
    const staleRecorder = FakeMediaRecorder.instances[0];
    const staleStream = issuedStreams[1];

    await recorder.update("call-session-2");
    await act(async () => {
      staleRecorder.stop();
      staleRecorder.finishStop();
      await Promise.resolve();
    });
    await flushReact();

    expect(onSubmitAudio).not.toHaveBeenCalled();
    expect(staleStream.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(recorder.current.status).toBe("listening");
    expect(FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]).not.toBe(staleRecorder);
  });

  it("keeps live capture running while assistant speech is playing", async () => {
    const onSubmitAudio = vi.fn(async () => null);
    const recorder = await mountRecorder({ onSubmitAudio });
    const activeRecorder = FakeMediaRecorder.instances[0];
    const activeStream = issuedStreams[1];

    await recorder.update("call-session-1", onSubmitAudio, true);

    expect(activeRecorder.stopCalls).toBe(0);
    expect(activeStream.tracks[0].stop).not.toHaveBeenCalled();
    expect(onSubmitAudio).not.toHaveBeenCalled();
    expect(recorder.current.status).toBe("listening");
    expect(recorder.current.statusMessage).toBe("Listening...");

    await recorder.update("call-session-1", onSubmitAudio, false);

    expect(recorder.current.status).toBe("listening");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("does not treat assistant playback echo as user speech", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
        isSecureContext: true,
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
      },
    });
    fakeAudioRms = 0.04;
    const onSubmitAudio = vi.fn(async () => null);
    const recorder = await mountRecorder({ echoGateActive: true, onSubmitAudio });
    const activeRecorder = FakeMediaRecorder.instances[0];

    await act(async () => {
      vi.advanceTimersByTime(CALL_MODE_VAD_MIN_SPEECH_MS + CALL_MODE_VAD_SILENCE_MS + CALL_MODE_VAD_POLL_MS);
    });

    expect(activeRecorder.stopCalls).toBe(0);
    expect(recorder.current.isVoiceActive).toBe(false);
    expect(onSubmitAudio).not.toHaveBeenCalled();

    await recorder.update("call-session-1", onSubmitAudio, false);

    expect(recorder.current.status).toBe("listening");
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });
});
