import { useCallback, useEffect, useRef, useState } from "react";
import {
  CALL_TTS_DEFAULT_GAP_MS,
  synthesizeCallTtsAudio,
  type CallTtsProviderId,
  type CallTtsSettings,
} from "./callTts";

const VOICE_SPEECH_CHUNK_CHARS = 160;

export type VoiceSpeechPolicy = "queue" | "barge-in" | "barge-in-resume";

type QueuedVoiceSpeech = {
  id: number;
  speechId: number;
  text: string;
  audioUrl: string | null;
  provider: CallTtsProviderId;
};

type UseVoiceSpeechOutboxOptions = {
  settings: CallTtsSettings;
  enabled: boolean;
  isLive: boolean;
  ducking: boolean;
  blocked: boolean;
  onDrainComplete: () => void;
  onSpeakingChange?: (isSpeaking: boolean) => void;
};

export function normalizeVoiceSpeechText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function voiceSpeechChunks(text: string) {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > VOICE_SPEECH_CHUNK_CHARS) {
    const windowText = rest.slice(0, VOICE_SPEECH_CHUNK_CHARS);
    const breakIndex = Math.max(
      windowText.lastIndexOf("。"),
      windowText.lastIndexOf("！"),
      windowText.lastIndexOf("？"),
      windowText.lastIndexOf(". "),
      windowText.lastIndexOf("; "),
      windowText.lastIndexOf(", "),
      windowText.lastIndexOf("，"),
    );
    const splitAt = breakIndex >= 48 ? breakIndex + 1 : VOICE_SPEECH_CHUNK_CHARS;
    chunks.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function browserSpeechAvailable() {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && window.speechSynthesis
    && typeof SpeechSynthesisUtterance !== "undefined";
}

function cancelBrowserSpeech() {
  if (browserSpeechAvailable()) {
    window.speechSynthesis.cancel();
  }
}

function canUseSettings(settings: CallTtsSettings) {
  return typeof window !== "undefined"
    && (settings.provider !== "browser" || browserSpeechAvailable());
}

export function useVoiceSpeechOutbox({
  settings,
  enabled,
  isLive,
  ducking,
  blocked,
  onDrainComplete,
  onSpeakingChange,
}: UseVoiceSpeechOutboxOptions) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState("");
  const queueRef = useRef<QueuedVoiceSpeech[]>([]);
  const readyByJobIdRef = useRef<Map<number, QueuedVoiceSpeech>>(new Map());
  const nextReadyJobIdRef = useRef(1);
  const currentRef = useRef<QueuedVoiceSpeech | null>(null);
  const speakingRef = useRef(false);
  const duckingRef = useRef(ducking);
  const blockedRef = useRef(blocked);
  const enabledRef = useRef(enabled);
  const isLiveRef = useRef(isLive);
  const utteranceIdRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const gapTimerRef = useRef<number | null>(null);
  const jobIdRef = useRef(0);
  const speechIdRef = useRef(0);
  const generationRef = useRef(0);
  const settingsRef = useRef(settings);
  const onDrainCompleteRef = useRef(onDrainComplete);
  const onSpeakingChangeRef = useRef(onSpeakingChange);

  duckingRef.current = ducking;
  blockedRef.current = blocked;
  enabledRef.current = enabled;
  isLiveRef.current = isLive;
  settingsRef.current = settings;
  onDrainCompleteRef.current = onDrainComplete;
  onSpeakingChangeRef.current = onSpeakingChange;

  useEffect(() => {
    onSpeakingChangeRef.current?.(isSpeaking);
  }, [isSpeaking]);

  const setQueue = useCallback((queue: QueuedVoiceSpeech[]) => {
    queueRef.current = queue;
  }, []);

  const clearGapTimer = useCallback(() => {
    if (gapTimerRef.current === null || typeof window === "undefined") return;
    window.clearTimeout(gapTimerRef.current);
    gapTimerRef.current = null;
  }, []);

  const stopCurrentAudio = useCallback((revokeUrl = true) => {
    if (!audioRef.current) return;
    audioRef.current.onended = null;
    audioRef.current.onerror = null;
    audioRef.current.pause();
    audioRef.current.src = "";
    audioRef.current = null;
    if (revokeUrl && audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
    }
    audioUrlRef.current = null;
  }, []);

  const releaseQueuedSpeech = useCallback((queue: QueuedVoiceSpeech[]) => {
    for (const item of queue) {
      if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
    }
  }, []);

  const releasePendingSpeech = useCallback(() => {
    releaseQueuedSpeech(Array.from(readyByJobIdRef.current.values()));
    readyByJobIdRef.current.clear();
    nextReadyJobIdRef.current = jobIdRef.current + 1;
  }, [releaseQueuedSpeech]);

  const stop = useCallback((options: { preserveDrain?: boolean } = {}) => {
    clearGapTimer();
    releaseQueuedSpeech(queueRef.current);
    releasePendingSpeech();
    setQueue([]);
    speakingRef.current = false;
    utteranceIdRef.current += 1;
    generationRef.current += 1;
    setIsSpeaking(false);
    stopCurrentAudio();
    currentRef.current = null;
    cancelBrowserSpeech();
    if (!options.preserveDrain) onDrainCompleteRef.current();
  }, [clearGapTimer, releasePendingSpeech, releaseQueuedSpeech, setQueue, stopCurrentAudio]);

  const finishCurrent = useCallback(() => {
    stopCurrentAudio();
    currentRef.current = null;
    speakingRef.current = false;
    setIsSpeaking(false);
    if (queueRef.current.length === 0) {
      if (!isLiveRef.current) onDrainCompleteRef.current();
      return;
    }
    const gapMs = CALL_TTS_DEFAULT_GAP_MS;
    if (gapMs <= 0 || typeof window === "undefined") {
      playNextRef.current();
      return;
    }
    clearGapTimer();
    gapTimerRef.current = window.setTimeout(() => {
      gapTimerRef.current = null;
      playNextRef.current();
    }, gapMs);
  }, [clearGapTimer, stopCurrentAudio]);

  const playNextRef = useRef<() => void>(() => {});
  playNextRef.current = () => {
    clearGapTimer();
    if (!enabledRef.current || speakingRef.current || blockedRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      if (!isLiveRef.current) onDrainCompleteRef.current();
      return;
    }
    currentRef.current = next;
    utteranceIdRef.current += 1;
    const utteranceId = utteranceIdRef.current;
    if (next.audioUrl && typeof Audio !== "undefined") {
      const audio = new Audio(next.audioUrl);
      audioRef.current = audio;
      audioUrlRef.current = next.audioUrl;
      audio.volume = duckingRef.current ? 0.78 : 1;
      audio.onended = () => {
        if (utteranceId === utteranceIdRef.current) finishCurrent();
      };
      audio.onerror = () => {
        if (utteranceId === utteranceIdRef.current) finishCurrent();
      };
      speakingRef.current = true;
      setIsSpeaking(true);
      cancelBrowserSpeech();
      void audio.play().catch(() => {
        if (utteranceId === utteranceIdRef.current) finishCurrent();
      });
      return;
    }

    if (!browserSpeechAvailable()) {
      finishCurrent();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(next.text);
    utterance.lang = settingsRef.current.language;
    utterance.volume = duckingRef.current ? 0.78 : 1;
    utterance.rate = settingsRef.current.rate;
    utterance.onend = () => {
      if (utteranceId === utteranceIdRef.current) finishCurrent();
    };
    utterance.onerror = () => {
      if (utteranceId === utteranceIdRef.current) finishCurrent();
    };
    speakingRef.current = true;
    setIsSpeaking(true);
    stopCurrentAudio();
    cancelBrowserSpeech();
    window.speechSynthesis.speak(utterance);
  };

  const interrupt = useCallback((options: { requeueCurrent?: boolean } = {}) => {
    const requeueCurrent = options.requeueCurrent ?? true;
    const current = currentRef.current;
    currentRef.current = null;
    speakingRef.current = false;
    utteranceIdRef.current += 1;
    setIsSpeaking(false);
    if (current && requeueCurrent) {
      setQueue([current, ...queueRef.current]);
    }
    stopCurrentAudio(false);
    cancelBrowserSpeech();
    return current;
  }, [setQueue, stopCurrentAudio]);

  const queueAtFront = useCallback((text: string, resumeQueue: QueuedVoiceSpeech[]) => {
    const trimmed = normalizeVoiceSpeechText(text);
    const currentSettings = settingsRef.current;
    const chunks = voiceSpeechChunks(trimmed);
    if (chunks.length === 0 || !canUseSettings(currentSettings)) {
      setQueue([...resumeQueue, ...queueRef.current]);
      playNextRef.current();
      return false;
    }
    const speechId = ++speechIdRef.current;
    if (currentSettings.provider === "browser") {
      const speech = chunks.map((chunk) => ({
        id: ++jobIdRef.current,
        speechId,
        text: chunk,
        audioUrl: null,
        provider: "browser" as const,
      }));
      setQueue([...speech, ...resumeQueue, ...queueRef.current]);
      playNextRef.current();
      return true;
    }
    const generation = generationRef.current;
    const jobs: Promise<QueuedVoiceSpeech | null>[] = chunks.map((chunk) => {
      const id = ++jobIdRef.current;
      return synthesizeCallTtsAudio(chunk, currentSettings)
        .then((audio): QueuedVoiceSpeech => ({
          id,
          speechId,
          text: chunk,
          audioUrl: audio.url,
          provider: currentSettings.provider,
        }))
        .catch((err): QueuedVoiceSpeech | null => {
          if (generation !== generationRef.current) return null;
          setStatus(err instanceof Error ? err.message : "TTS provider failed; using browser voice.");
          return {
            id,
            speechId,
            text: chunk,
            audioUrl: null,
            provider: "browser" as const,
          };
        });
    });
    void Promise.all(jobs).then((speech) => {
      if (generation !== generationRef.current) {
        for (const item of speech) {
          if (item?.audioUrl) URL.revokeObjectURL(item.audioUrl);
        }
        return;
      }
      if (speech.every((item) => item?.provider === currentSettings.provider)) setStatus("");
      setQueue([
        ...speech.filter((item): item is QueuedVoiceSpeech => item !== null),
        ...resumeQueue,
        ...queueRef.current,
      ]);
      playNextRef.current();
    });
    return true;
  }, [setQueue]);

  const flushReady = useCallback(() => {
    const ready: QueuedVoiceSpeech[] = [];
    while (true) {
      const next = readyByJobIdRef.current.get(nextReadyJobIdRef.current);
      if (!next) break;
      readyByJobIdRef.current.delete(nextReadyJobIdRef.current);
      nextReadyJobIdRef.current += 1;
      ready.push(next);
    }
    if (ready.length === 0) return;
    setQueue([...queueRef.current, ...ready]);
    playNextRef.current();
  }, [setQueue]);

  const enqueueReady = useCallback((item: QueuedVoiceSpeech) => {
    readyByJobIdRef.current.set(item.id, item);
    flushReady();
  }, [flushReady]);

  const speak = useCallback((text: string, policy: VoiceSpeechPolicy = "queue") => {
    const trimmed = normalizeVoiceSpeechText(text);
    const currentSettings = settingsRef.current;
    const chunks = voiceSpeechChunks(trimmed);
    if (chunks.length === 0 || !enabledRef.current || !canUseSettings(currentSettings)) return false;
    if (policy === "barge-in-resume") {
      interrupt({ requeueCurrent: false });
      const resumeQueue = queueRef.current;
      setQueue([]);
      return queueAtFront(trimmed, resumeQueue);
    }
    if (policy === "barge-in") stop();
    const speechId = ++speechIdRef.current;
    const generation = generationRef.current;
    if (currentSettings.provider === "browser") {
      for (const chunk of chunks) {
        enqueueReady({
          id: ++jobIdRef.current,
          speechId,
          text: chunk,
          audioUrl: null,
          provider: "browser",
        });
      }
      return true;
    }

    for (const chunk of chunks) {
      const id = ++jobIdRef.current;
      void synthesizeCallTtsAudio(chunk, currentSettings)
        .then((audio) => {
          if (generation !== generationRef.current) {
            URL.revokeObjectURL(audio.url);
            return;
          }
          setStatus("");
          enqueueReady({
            id,
            speechId,
            text: chunk,
            audioUrl: audio.url,
            provider: currentSettings.provider,
          });
        })
        .catch((err) => {
          if (generation !== generationRef.current) return;
          setStatus(err instanceof Error ? err.message : "TTS provider failed; using browser voice.");
          enqueueReady({
            id,
            speechId,
            text: chunk,
            audioUrl: null,
            provider: "browser",
          });
        });
    }
    return true;
  }, [enqueueReady, interrupt, queueAtFront, setQueue, stop]);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    if (!blocked) {
      if (!speakingRef.current && queueRef.current.length > 0) playNextRef.current();
      return;
    }
    if (!speakingRef.current) return;
    interrupt();
  }, [blocked, enabled, interrupt, stop]);

  useEffect(() => () => {
    clearGapTimer();
    releaseQueuedSpeech(queueRef.current);
    releasePendingSpeech();
    queueRef.current = [];
    speakingRef.current = false;
    stopCurrentAudio();
    cancelBrowserSpeech();
  }, [clearGapTimer, releasePendingSpeech, releaseQueuedSpeech, stopCurrentAudio]);

  return {
    isSpeaking,
    status,
    speak,
    stop,
  };
}
