import { useCallback, useState } from "react";
import { useVoiceAgentRecorder } from "./useVoiceAgentRecorder";

type UseHybridVoiceInputOptions = {
  lang?: string;
  onFinalTranscript: (text: string) => void;
};

type VoiceInputMode = "recorded" | null;

export function useHybridVoiceInput({
  lang = "zh-CN",
  onFinalTranscript,
}: UseHybridVoiceInputOptions) {
  const [mode, setMode] = useState<VoiceInputMode>(null);
  const recorder = useVoiceAgentRecorder({
    language: lang,
    onTranscript: (result) => {
      setMode(null);
      onFinalTranscript(result.text);
    },
  });

  const start = useCallback(() => {
    recorder.cancel();

    if (recorder.isSupported) {
      setMode("recorded");
      void recorder.start();
      return;
    }

    setMode(null);
  }, [recorder]);

  const stop = useCallback(() => {
    if (mode === "recorded" || recorder.isRecording) recorder.stop();
  }, [mode, recorder]);

  const abort = useCallback(() => {
    recorder.cancel();
    setMode(null);
  }, [recorder]);

  const isSupported = recorder.isSupported;
  const isListening = recorder.isRecording;
  const isRequestingPermission = recorder.isRequestingPermission;
  const isTranscribing = recorder.isTranscribing;
  const isStarting = recorder.isRequestingPermission || recorder.isTranscribing;
  const error = recorder.error;

  return {
    abort,
    error,
    interimTranscript: "",
    isListening,
    isRecordedInput: true,
    isRequestingPermission,
    isStarting,
    isSupported,
    isTranscribing,
    limits: recorder.limits,
    mode,
    recordingElapsedMs: recorder.recordingElapsedMs,
    start,
    statusMessage: recorder.statusMessage,
    stop,
  };
}
