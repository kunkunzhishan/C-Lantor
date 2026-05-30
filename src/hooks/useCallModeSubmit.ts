import { useCallback, useEffect, useState } from "react";
import {
  cancelCallDispatchWork,
  resolveCallDispatchConfirmation,
  startCallSession,
  stopCallSession,
  submitRecordedCallUtterance,
  submitTypedCallUtterance,
} from "../callModeClient";
import type { CallSession, CallUtteranceSubmitResult } from "../types";

type UseCallModeSubmitOptions = {
  channelId: string | null;
  threadRootId?: string | null;
  title?: string;
  surfaceSession?: CallSession | null;
  language?: string;
};

type SubmitRecordedUtteranceInput = {
  audio: Blob;
  sessionId: string;
  mimeType: string;
  originalName: string;
  durationMs: number;
  finalFragmentReason?: "mute" | "end_call";
};

type SubmitTypedUtteranceInput = {
  transcript: string;
  threadRootUtteranceId?: string | null;
};

function belongsToSurface(
  session: CallSession | null,
  channelId: string | null,
  threadRootId: string | null,
) {
  if (!session) return false;
  return session.channel_id === channelId && session.thread_root_id === threadRootId;
}

function upsertSubmitResult(
  results: CallUtteranceSubmitResult[],
  result: CallUtteranceSubmitResult,
) {
  return [
    ...results.filter((item) =>
      item.session.id === result.session.id
      && item.utterance.id !== result.utterance.id
      && item.dispatch.id !== result.dispatch.id
    ),
    result,
  ]
    .sort((left, right) => left.utterance.sequence - right.utterance.sequence)
    .slice(-20);
}

export function useCallModeSubmit({
  channelId,
  threadRootId = null,
  title,
  surfaceSession = null,
  language = "zh-CN",
}: UseCallModeSubmitOptions) {
  const [session, setSession] = useState<CallSession | null>(surfaceSession);
  const [lastResult, setLastResult] = useState<CallUtteranceSubmitResult | null>(null);
  const [submitResults, setSubmitResults] = useState<CallUtteranceSubmitResult[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isControllingWork, setIsControllingWork] = useState(false);
  const [isResolvingConfirmation, setIsResolvingConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (surfaceSession) {
      setSession(surfaceSession);
      setLastResult((current) => current?.session.id === surfaceSession.id ? current : null);
      setSubmitResults((current) => current.filter((item) => item.session.id === surfaceSession.id));
      return;
    }
    setSession((current) => belongsToSurface(current, channelId, threadRootId) ? current : null);
    setLastResult((current) => belongsToSurface(current?.session ?? null, channelId, threadRootId) ? current : null);
    setSubmitResults((current) => current.filter((item) => belongsToSurface(item.session, channelId, threadRootId)));
  }, [surfaceSession, channelId, threadRootId]);

  const start = useCallback(async () => {
    if (
      session?.status === "active"
      && session.channel_id === channelId
      && (threadRootId ? session.thread_root_id === threadRootId : session.thread_root_id === null)
    ) {
      return session;
    }
    setError(null);
    setIsStarting(true);
    try {
      const next = await startCallSession({
        channelId,
        threadRootId,
        title,
      });
      setSession(next);
      setLastResult(null);
      setSubmitResults([]);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsStarting(false);
    }
  }, [channelId, session, threadRootId, title]);

  const stop = useCallback(async () => {
    const current = session;
    if (!current || current.status !== "active") return null;
    setError(null);
    setIsStopping(true);
    try {
      const next = await stopCallSession({ sessionId: current.id });
      setSession(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsStopping(false);
    }
  }, [language, session]);

  const submitRecordedUtterance = useCallback(async (input: SubmitRecordedUtteranceInput) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const active = session?.status === "active" && session.id === input.sessionId ? session : null;
      if (!active) {
        throw new Error("Call recording was discarded because the call ended.");
      }
      const result = await submitRecordedCallUtterance({
        sessionId: active.id,
        audio: input.audio,
        mimeType: input.mimeType,
        originalName: input.originalName,
        durationMs: input.durationMs,
        language,
        finalFragmentReason: input.finalFragmentReason,
      });
      setSession(result.session);
      setLastResult(result);
      setSubmitResults((current) => upsertSubmitResult(current, result));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  }, [language, session]);

  const submitTypedUtterance = useCallback(async (input: SubmitTypedUtteranceInput) => {
    const current = session;
    if (!current || current.status !== "active") {
      throw new Error("Typed call utterance cannot be submitted because the call is not live.");
    }
    const transcript = input.transcript.trim();
    if (!transcript) {
      throw new Error("Typed call utterance cannot be empty.");
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await submitTypedCallUtterance({
        sessionId: current.id,
        transcript,
        language,
        ...(input.threadRootUtteranceId ? { threadRootUtteranceId: input.threadRootUtteranceId } : null),
      });
      setSession(result.session);
      setLastResult(result);
      setSubmitResults((current) => upsertSubmitResult(current, result));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  }, [language, session]);

  const cancelWork = useCallback(async (workItemId: string) => {
    const current = session;
    if (!current || current.status !== "active") {
      throw new Error("Call work cannot be cancelled because the call is not live.");
    }
    setError(null);
    setIsControllingWork(true);
    try {
      const result = await cancelCallDispatchWork({
        sessionId: current.id,
        workItemId,
        language,
      });
      setSession(result.session);
      setLastResult(result);
      setSubmitResults((current) => upsertSubmitResult(current, result));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsControllingWork(false);
    }
  }, [language, session]);

  const resolveConfirmation = useCallback(async (transcript: string) => {
    const current = session;
    if (!current || current.status !== "active") {
      throw new Error("Call confirmation cannot be resolved because the call is not live.");
    }
    const cleanTranscript = transcript.trim();
    if (!cleanTranscript) {
      throw new Error("Call confirmation response cannot be empty.");
    }
    setError(null);
    setIsResolvingConfirmation(true);
    try {
      const result = await resolveCallDispatchConfirmation({
        sessionId: current.id,
        transcript: cleanTranscript,
        language,
      });
      setSession(result.session);
      setLastResult(result);
      setSubmitResults((current) => upsertSubmitResult(current, result));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setIsResolvingConfirmation(false);
    }
  }, [session]);

  return {
    cancelWork,
    error,
    isLive: session?.status === "active",
    isControllingWork,
    isResolvingConfirmation,
    isStarting,
    isStopping,
    isSubmitting,
    lastResult,
    resolveConfirmation,
    session,
    start,
    stop,
    submitResults,
    submitRecordedUtterance,
    submitTypedUtterance,
  };
}
