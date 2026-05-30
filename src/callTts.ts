import { apiInvoke } from "./apiClient";

export type CallTtsProviderId = "browser" | "edge";
export type CallVoiceLanguage = "zh-CN" | "en-US";

export type CallTtsVoice = {
  id: string;
  label: string;
  provider: CallTtsProviderId;
  language: CallVoiceLanguage;
};

export type CallTtsSettings = {
  provider: CallTtsProviderId;
  language: CallVoiceLanguage;
  voice: string;
  rate: number;
};

export type CallTtsAudio = {
  provider: CallTtsProviderId;
  mimeType: string;
  url: string;
};

type TtsSynthesisResponse = {
  provider: string;
  mime_type: string;
  bytes: number[];
};

export const CALL_TTS_BROWSER_VOICE = "browser-auto";
export const CALL_TTS_DEFAULT_GAP_MS = 1000;
export const CALL_VOICE_LANGUAGES: { id: CallVoiceLanguage; label: string }[] = [
  { id: "zh-CN", label: "Chinese" },
  { id: "en-US", label: "English" },
];

export const CALL_TTS_VOICES: CallTtsVoice[] = [
  { id: CALL_TTS_BROWSER_VOICE, label: "Browser Auto", provider: "browser", language: "zh-CN" },
  { id: "zh-CN-XiaoxiaoNeural", label: "Xiaoxiao", provider: "edge", language: "zh-CN" },
  { id: "zh-CN-XiaoyiNeural", label: "Xiaoyi", provider: "edge", language: "zh-CN" },
  { id: "zh-CN-YunxiNeural", label: "Yunxi", provider: "edge", language: "zh-CN" },
  { id: "zh-CN-YunjianNeural", label: "Yunjian", provider: "edge", language: "zh-CN" },
  { id: "zh-CN-YunyangNeural", label: "Yunyang", provider: "edge", language: "zh-CN" },
  { id: "en-US-JennyNeural", label: "Jenny", provider: "edge", language: "en-US" },
  { id: "en-US-GuyNeural", label: "Guy", provider: "edge", language: "en-US" },
  { id: "en-US-AriaNeural", label: "Aria", provider: "edge", language: "en-US" },
];

export const DEFAULT_CALL_TTS_SETTINGS: CallTtsSettings = {
  provider: "browser",
  language: "zh-CN",
  voice: CALL_TTS_BROWSER_VOICE,
  rate: 1,
};

export function voicesForCallTtsProvider(provider: CallTtsProviderId, language: CallVoiceLanguage = DEFAULT_CALL_TTS_SETTINGS.language) {
  return CALL_TTS_VOICES.filter((voice) => voice.provider === provider && (provider === "browser" || voice.language === language));
}

export function normalizeCallTtsSettings(input: Partial<CallTtsSettings>): CallTtsSettings {
  const provider = input.provider === "edge" ? "edge" : "browser";
  const language = input.language === "en-US" ? "en-US" : "zh-CN";
  const providerVoices = voicesForCallTtsProvider(provider, language);
  const voice = providerVoices.some((item) => item.id === input.voice)
    ? input.voice as string
    : providerVoices[0]?.id ?? DEFAULT_CALL_TTS_SETTINGS.voice;
  const rate = Number.isFinite(input.rate) ? Math.min(2, Math.max(0.5, Number(input.rate))) : 1;

  return { provider, language, voice, rate };
}

export async function synthesizeCallTtsAudio(
  text: string,
  settings: CallTtsSettings,
): Promise<CallTtsAudio> {
  if (settings.provider === "browser") {
    throw new Error("Browser provider does not synthesize audio.");
  }
  const response = await apiInvoke<TtsSynthesisResponse>("synthesize_tts_audio", {
    provider: settings.provider,
    text,
    voice: settings.voice,
    rate: settings.rate,
  });
  const bytes = new Uint8Array(response.bytes);
  const blob = new Blob([bytes], { type: response.mime_type || "audio/mpeg" });
  return {
    provider: settings.provider,
    mimeType: response.mime_type || "audio/mpeg",
    url: URL.createObjectURL(blob),
  };
}
