import { ApiClientError, apiInvoke } from "./apiClient";

export type VoiceTranscriptionResult = {
  text: string;
  provider: string;
  mimeType: string;
  originalName: string | null;
  durationMs: number | null;
};

export type VoiceTranscriptionRequestMetadata = {
  mimeType?: string;
  filename?: string;
  durationMs?: number;
  language?: string;
};

export type VoiceAudioBytes = ArrayBuffer | Uint8Array | readonly number[];

export type VoiceBlobTranscriptionInput = VoiceTranscriptionRequestMetadata & {
  audio: Blob;
};

export type VoiceByteTranscriptionInput = VoiceTranscriptionRequestMetadata & {
  bytes: VoiceAudioBytes;
};

export type VoiceTranscriptionInput = VoiceBlobTranscriptionInput | VoiceByteTranscriptionInput;

export class VoiceTranscriptionClientError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(message: string, options: { code?: string; status?: number | null } = {}) {
    super(message);
    this.name = "VoiceTranscriptionClientError";
    this.code = options.code ?? "transcriptionFailed";
    this.status = options.status ?? null;
  }
}

type TranscribeVoiceAudioCommandResponse = {
  text: string;
  provider: string;
  mimeType: string;
  originalName?: string | null;
  durationMs?: number | null;
};

type TranscribeVoiceAudioCommandArgs = {
  bytes: number[];
  mimeType: string;
  originalName?: string;
  durationMs?: number;
  language?: string;
};

function normalizeFilename(value: string | undefined) {
  const filename = value?.trim();
  return filename ? filename : undefined;
}

function normalizeLanguage(value: string | undefined) {
  const language = value?.trim();
  return language ? language : undefined;
}

function normalizeMimeType(input: VoiceTranscriptionInput) {
  const explicitMimeType = input.mimeType?.trim();
  if (explicitMimeType) return explicitMimeType;
  if ("audio" in input && input.audio.type.trim()) return input.audio.type.trim();
  return "application/octet-stream";
}

async function audioBytesFromInput(input: VoiceTranscriptionInput) {
  if ("audio" in input) {
    return Array.from(new Uint8Array(await input.audio.arrayBuffer()));
  }
  if (input.bytes instanceof ArrayBuffer) return Array.from(new Uint8Array(input.bytes));
  if (input.bytes instanceof Uint8Array) return Array.from(input.bytes);
  return Array.from(input.bytes);
}

function normalizeDurationMs(value: number | undefined) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new VoiceTranscriptionClientError("Voice audio duration is invalid.", { code: "invalidDuration" });
  }
  return Math.round(value);
}

function normalizeClientError(err: unknown): VoiceTranscriptionClientError {
  if (err instanceof VoiceTranscriptionClientError) return err;
  if (err instanceof ApiClientError) {
    if (err.code === "expectedJson") {
      return new VoiceTranscriptionClientError(
        "Voice transcription service is unavailable. Check the web backend connection and try again.",
        { code: "transcriptionServiceUnavailable", status: err.status },
      );
    }
    return new VoiceTranscriptionClientError(err.message, {
      code: err.code ?? "transcriptionFailed",
      status: err.status,
    });
  }
  if (err instanceof Error) return voiceErrorFromTauriMessage(err.message);
  if (typeof err === "string") return voiceErrorFromTauriMessage(err);
  return new VoiceTranscriptionClientError("Voice transcription failed.");
}

function voiceErrorFromTauriMessage(message: string) {
  const match = message.match(/^([a-z][a-zA-Z0-9]*):\s*(.+)$/);
  if (!match) return new VoiceTranscriptionClientError(message);
  return new VoiceTranscriptionClientError(match[2], { code: match[1] });
}

export async function transcribeVoiceAudio(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult> {
  try {
    const bytes = await audioBytesFromInput(input);
    if (bytes.length === 0) {
      throw new VoiceTranscriptionClientError("Voice audio is required.", { code: "emptyAudio" });
    }

    const args: TranscribeVoiceAudioCommandArgs = {
      bytes,
      mimeType: normalizeMimeType(input),
    };
    const originalName = normalizeFilename(input.filename);
    const durationMs = normalizeDurationMs(input.durationMs);
    const language = normalizeLanguage(input.language);
    if (originalName) args.originalName = originalName;
    if (durationMs !== undefined) args.durationMs = durationMs;
    if (language) args.language = language;

    const result = await apiInvoke<TranscribeVoiceAudioCommandResponse>("transcribe_voice_audio", args);
    return {
      text: result.text,
      provider: result.provider,
      mimeType: result.mimeType,
      originalName: result.originalName ?? null,
      durationMs: result.durationMs ?? null,
    };
  } catch (err) {
    throw normalizeClientError(err);
  }
}
