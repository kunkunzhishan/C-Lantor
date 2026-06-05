import { apiInvoke } from "./apiClient";
import type { CallSession, CallUtteranceSubmitResult } from "./types";

type StartCallSessionInput = {
  channelId?: string | null;
  threadRootId?: string | null;
  title?: string | null;
  mode?: "call" | "wake_word";
  wakeWords?: string;
};

type StopCallSessionInput = {
  sessionId: string;
};

type CancelCallWorkInput = {
  sessionId: string;
  workItemId: string;
  language?: string;
};

type ResolveCallConfirmationInput = {
  sessionId: string;
  transcript: string;
  language?: string;
};

type SubmitTypedCallUtteranceInput = {
  sessionId: string;
  transcript: string;
  threadRootUtteranceId?: string | null;
  language?: string;
};

type SubmitCallUtteranceInput = {
  sessionId: string;
  bytes: number[];
  mimeType: string;
  originalName?: string;
  durationMs?: number;
  language?: string;
  finalFragmentReason?: "mute" | "end_call";
};

type SubmitRecordedCallUtteranceInput = {
  sessionId: string;
  audio: Blob;
  mimeType?: string;
  originalName?: string;
  durationMs?: number;
  language?: string;
  finalFragmentReason?: "mute" | "end_call";
};

function cleanOptionalString(value: string | null | undefined) {
  const next = value?.trim();
  return next ? next : undefined;
}

export async function bytesFromBlob(blob: Blob) {
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

export async function startCallSession(input: StartCallSessionInput): Promise<CallSession> {
  return apiInvoke<CallSession>("call_session_start", {
    channelId: input.channelId ?? null,
    threadRootId: input.threadRootId ?? null,
    title: cleanOptionalString(input.title) ?? null,
    mode: input.mode ?? "call",
    wakeWords: cleanOptionalString(input.wakeWords) ?? null,
  });
}

export async function stopCallSession(input: StopCallSessionInput): Promise<CallSession> {
  return apiInvoke<CallSession>("call_session_stop", {
    sessionId: input.sessionId,
  });
}

export async function cancelCallDispatchWork(input: CancelCallWorkInput): Promise<CallUtteranceSubmitResult> {
  const args: Record<string, unknown> = {
    sessionId: input.sessionId,
    workItemId: input.workItemId,
  };
  const language = cleanOptionalString(input.language);
  if (language) args.language = language;
  return apiInvoke<CallUtteranceSubmitResult>("call_dispatch_cancel_work", args);
}

export async function resolveCallDispatchConfirmation(
  input: ResolveCallConfirmationInput,
): Promise<CallUtteranceSubmitResult> {
  const args: Record<string, unknown> = {
    sessionId: input.sessionId,
    transcript: input.transcript.trim(),
  };
  const language = cleanOptionalString(input.language);
  if (language) args.language = language;
  return apiInvoke<CallUtteranceSubmitResult>("call_dispatch_resolve_confirmation", args);
}

export async function submitTypedCallUtterance(
  input: SubmitTypedCallUtteranceInput,
): Promise<CallUtteranceSubmitResult> {
  const args: Record<string, unknown> = {
    sessionId: input.sessionId,
    transcript: input.transcript.trim(),
  };
  if (input.threadRootUtteranceId) args.threadRootUtteranceId = input.threadRootUtteranceId;
  const language = cleanOptionalString(input.language);
  if (language) args.language = language;
  return apiInvoke<CallUtteranceSubmitResult>("call_session_submit_text_utterance", args);
}

export async function submitCallUtterance(input: SubmitCallUtteranceInput): Promise<CallUtteranceSubmitResult> {
  const args: Record<string, unknown> = {
    sessionId: input.sessionId,
    bytes: input.bytes,
    mimeType: input.mimeType,
  };
  const originalName = cleanOptionalString(input.originalName);
  const language = cleanOptionalString(input.language);
  if (originalName) args.originalName = originalName;
  if (input.durationMs !== undefined) args.durationMs = Math.max(0, Math.round(input.durationMs));
  if (language) args.language = language;
  if (input.finalFragmentReason) args.finalFragmentReason = input.finalFragmentReason;
  return apiInvoke<CallUtteranceSubmitResult>("call_session_submit_utterance", args);
}

export async function submitRecordedCallUtterance(
  input: SubmitRecordedCallUtteranceInput,
): Promise<CallUtteranceSubmitResult> {
  const mimeType = cleanOptionalString(input.mimeType) ?? cleanOptionalString(input.audio.type) ?? "application/octet-stream";
  return submitCallUtterance({
    sessionId: input.sessionId,
    bytes: await bytesFromBlob(input.audio),
    mimeType,
    originalName: input.originalName,
    durationMs: input.durationMs,
    language: input.language,
    finalFragmentReason: input.finalFragmentReason,
  });
}
