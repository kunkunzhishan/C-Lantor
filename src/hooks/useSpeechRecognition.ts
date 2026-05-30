import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiInvoke, isTauriRuntime } from "../apiClient";

type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string };
};

type SpeechRecognitionEventLike = Event & {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionErrorEventLike = Event & {
  readonly error?: string;
  readonly message?: string;
};

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  webkitAudioContext?: typeof AudioContext;
};

export type SpeechRecognitionStatus = "idle" | "starting" | "listening" | "unsupported" | "error";
export type MicrophonePermissionStatus = "unknown" | "requesting" | "granted" | "denied";

type UseSpeechRecognitionOptions = {
  lang?: string;
  onFinalTranscript: (text: string) => void;
};

function speechConstructor() {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function errorMessage(event: SpeechRecognitionErrorEventLike) {
  if (event.error === "not-allowed" || event.error === "service-not-allowed") {
    if (event.message?.toLowerCase().includes("siri and dictation")) {
      return "Siri and Dictation are disabled. Enable Dictation in macOS System Settings.";
    }
    return "Speech recognition or microphone permission is blocked.";
  }
  if (event.error === "no-speech") return "No speech detected.";
  if (event.error === "audio-capture") return "No microphone was found.";
  return event.message || event.error || "Speech recognition failed.";
}

function microphonePermissionError(err: unknown) {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return "Microphone permission is blocked.";
    }
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      return "No microphone was found.";
    }
    if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      return "Microphone is already in use.";
    }
  }
  return err instanceof Error ? err.message : "Microphone permission could not be requested.";
}

function speechPermissionError(err: unknown) {
  return err instanceof Error ? err.message : "Speech recognition permission could not be requested.";
}

async function requestMicrophonePermission() {
  if (isTauriRuntime()) {
    await apiInvoke("request_microphone_permission");
    return;
  }

  if (navigator.mediaDevices?.getUserMedia) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  throw new Error("Microphone permission cannot be requested in this WebView.");
}

async function requestSpeechRecognitionPermission() {
  if (isTauriRuntime()) {
    await apiInvoke("request_speech_recognition_permission");
  }
}

export function useSpeechRecognition({
  lang = "zh-CN",
  onFinalTranscript,
}: UseSpeechRecognitionOptions) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const sessionIdRef = useRef(0);
  const audioMonitorCleanupRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<SpeechRecognitionStatus>(() => speechConstructor() ? "idle" : "unsupported");
  const [permissionStatus, setPermissionStatus] = useState<MicrophonePermissionStatus>("unknown");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const isSupported = useMemo(() => Boolean(speechConstructor()), []);

  const stopAudioMonitor = useCallback(() => {
    audioMonitorCleanupRef.current?.();
    audioMonitorCleanupRef.current = null;
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const abort = useCallback(() => {
    const recognition = recognitionRef.current;
    sessionIdRef.current += 1;
    recognitionRef.current = null;
    stopAudioMonitor();
    recognition?.abort();
    setInterimTranscript("");
    setStatusMessage("");
    setStatus(isSupported ? "idle" : "unsupported");
  }, [isSupported, stopAudioMonitor]);

  const start = useCallback(async () => {
    const Recognition = speechConstructor();
    if (!Recognition) {
      setStatus("unsupported");
      setError("Speech recognition is not supported in this WebView.");
      return;
    }
    setError(null);
    setInterimTranscript("");
    setStatusMessage("Starting voice input...");
    setStatus("starting");
    setPermissionStatus("requesting");
    const sessionId = sessionIdRef.current + 1;
    sessionIdRef.current = sessionId;
    const previousRecognition = recognitionRef.current;
    recognitionRef.current = null;
    stopAudioMonitor();
    previousRecognition?.abort();
    if (isTauriRuntime()) {
      try {
        await requestMicrophonePermission();
        await requestSpeechRecognitionPermission();
      } catch (err) {
        if (sessionIdRef.current !== sessionId) return;
        setPermissionStatus("denied");
        setError(err instanceof Error && err.message.toLowerCase().includes("speech")
          ? speechPermissionError(err)
          : microphonePermissionError(err));
        setStatus("error");
        return;
      }
      if (sessionIdRef.current !== sessionId) return;
    }
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    let deliveredTranscript = false;
    let fallbackTranscript = "";
    let microphoneLevelState: "unknown" | "unavailable" | "silent" | "heard" = "unknown";
    let startTimer: number | null = null;
    let noResultTimer: number | null = null;
    const clearTimers = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      if (noResultTimer !== null) {
        window.clearTimeout(noResultTimer);
        noResultTimer = null;
      }
      stopAudioMonitor();
    };
    const isActiveSession = () => sessionIdRef.current === sessionId && recognitionRef.current === recognition;
    const startAudioLevelMonitor = () => {
      if (isTauriRuntime() || !navigator.mediaDevices?.getUserMedia) return;
      const AudioContextConstructor = window.AudioContext ?? (window as SpeechWindow).webkitAudioContext;
      if (!AudioContextConstructor) return;

      navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
        if (!isActiveSession()) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const audioContext = new AudioContextConstructor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        let animationFrame: number | null = null;
        let silenceTimer: number | null = null;
        let closed = false;
        let maxPeak = 0;

        analyser.fftSize = 512;
        const samples = new Uint8Array(analyser.fftSize);
        source.connect(analyser);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
          if (silenceTimer !== null) window.clearTimeout(silenceTimer);
          source.disconnect();
          stream.getTracks().forEach((track) => track.stop());
          void audioContext.close();
        };
        audioMonitorCleanupRef.current = cleanup;

        silenceTimer = window.setTimeout(() => {
          if (!isActiveSession() || microphoneLevelState === "heard") return;
          microphoneLevelState = "silent";
          setStatusMessage("Listening... no microphone sound detected yet");
        }, 2500);

        const checkLevel = () => {
          if (!isActiveSession()) {
            cleanup();
            return;
          }

          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) {
            peak = Math.max(peak, Math.abs(sample - 128));
          }
          maxPeak = Math.max(maxPeak, peak);
          if (peak >= 12 && microphoneLevelState !== "heard") {
            microphoneLevelState = "heard";
            setStatusMessage("Listening... microphone audio detected");
          }
          animationFrame = window.requestAnimationFrame(checkLevel);
        };
        checkLevel();
      }).catch((err) => {
        if (!isActiveSession() || microphoneLevelState === "heard") return;
        microphoneLevelState = "unavailable";
        setStatusMessage("Listening... microphone level unavailable");
      });
    };
    const endWithError = (message: string) => {
      if (!isActiveSession()) return;
      clearTimers();
      setError(message);
      setStatus("error");
      recognitionRef.current = null;
      sessionIdRef.current += 1;
      recognition.abort();
    };
    const armNoResultTimer = () => {
      if (noResultTimer !== null) window.clearTimeout(noResultTimer);
      noResultTimer = window.setTimeout(() => {
        if (!isActiveSession()) return;
        if (!deliveredTranscript && !fallbackTranscript.trim()) {
          const message = microphoneLevelState === "heard"
            ? "Microphone audio was detected, but speech recognition returned no text. Try Safari/Chrome directly or use keyboard dictation."
            : microphoneLevelState === "silent"
            ? "Voice input started, but no microphone sound was detected. Check the selected microphone and speak closer to it."
            : "Voice input started, but no speech was recognized. Try Safari/Chrome directly and check microphone access for this site.";
          endWithError(message);
        }
      }, 15000);
    };
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => {
      if (!isActiveSession()) return;
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      setError(null);
      setInterimTranscript("");
      setStatusMessage("Listening...");
      setPermissionStatus("granted");
      setStatus("listening");
      startAudioLevelMonitor();
      armNoResultTimer();
    };
    recognition.onresult = (event) => {
      if (!isActiveSession()) return;
      if (noResultTimer !== null) {
        window.clearTimeout(noResultTimer);
        noResultTimer = null;
      }
      let interim = "";
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = Array.from({ length: result.length }, (_, itemIndex) => result[itemIndex]?.transcript ?? "").join("");
        if (result.isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (finalText.trim()) {
        deliveredTranscript = true;
        clearTimers();
        onFinalTranscriptRef.current(finalText.trim());
        recognition.stop();
      }
      const nextInterim = interim.trim();
      if (nextInterim) fallbackTranscript = nextInterim;
      setStatusMessage(nextInterim ? "" : "Listening...");
      setInterimTranscript(nextInterim);
      if (!deliveredTranscript) armNoResultTimer();
    };
    recognition.onerror = (event) => {
      if (!isActiveSession()) return;
      clearTimers();
      if (event.error === "aborted") {
        recognitionRef.current = null;
        setInterimTranscript("");
        setStatusMessage("");
        setStatus(isSupported ? "idle" : "unsupported");
        stopAudioMonitor();
        return;
      }
      const message = errorMessage(event);
      setError(message);
      if (message.includes("permission is blocked")) setPermissionStatus("denied");
      setStatus(message === "No speech detected." ? "idle" : "error");
    };
    recognition.onend = () => {
      if (!isActiveSession()) return;
      clearTimers();
      recognitionRef.current = null;
      if (!deliveredTranscript && fallbackTranscript.trim()) {
        deliveredTranscript = true;
        onFinalTranscriptRef.current(fallbackTranscript.trim());
      }
      setInterimTranscript("");
      setStatusMessage("");
      setPermissionStatus((current) => current === "requesting" ? "unknown" : current);
      setStatus((current) => current === "unsupported" || current === "error" ? current : "idle");
    };
    try {
      recognition.start();
      startTimer = window.setTimeout(() => {
        if (!isActiveSession()) return;
        setPermissionStatus("unknown");
        endWithError("Voice input did not start microphone capture. This mobile browser may expose speech recognition but block it on this page.");
      }, 4000);
    } catch (err) {
      clearTimers();
      if (!isActiveSession()) return;
      setError(err instanceof Error ? err.message : "Speech recognition could not start.");
      setPermissionStatus("unknown");
      setStatus("error");
    }
  }, [isSupported, lang, stopAudioMonitor]);

  useEffect(() => () => {
    recognitionRef.current?.abort();
    stopAudioMonitor();
  }, [stopAudioMonitor]);

  return {
    abort,
    error,
    interimTranscript,
    isStarting: status === "starting",
    isListening: status === "listening",
    isRequestingPermission: permissionStatus === "requesting",
    isSupported,
    permissionStatus,
    start,
    status,
    statusMessage,
    stop,
  };
}
