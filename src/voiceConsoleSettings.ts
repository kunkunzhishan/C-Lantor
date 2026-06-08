import {
  DEFAULT_CALL_TTS_SETTINGS,
  normalizeCallTtsSettings,
  type CallTtsSettings,
} from "./callTts";

export type VoiceConsoleMode = "call" | "wake_word";

export type VoiceConsoleSettings = {
  mode: VoiceConsoleMode;
  wakeWords: string;
  tts: CallTtsSettings;
};

export type VoiceWakeSettings = Pick<VoiceConsoleSettings, "mode" | "wakeWords">;

const VOICE_CONSOLE_SETTINGS_STORAGE_KEY = "lantor.voiceConsoleSettings";

export const DEFAULT_VOICE_CONSOLE_SETTINGS: VoiceConsoleSettings = {
  mode: "wake_word",
  wakeWords: "兰托, 蓝托, Lantor",
  tts: DEFAULT_CALL_TTS_SETTINGS,
};

export function normalizeVoiceWakeSettings(value: Partial<VoiceWakeSettings> | null | undefined): VoiceWakeSettings {
  const mode = value?.mode === "call" ? "call" : DEFAULT_VOICE_CONSOLE_SETTINGS.mode;
  const wakeWords = value?.wakeWords?.trim() || DEFAULT_VOICE_CONSOLE_SETTINGS.wakeWords;
  return { mode, wakeWords };
}

export function normalizeVoiceConsoleSettings(value: Partial<VoiceConsoleSettings> | null | undefined): VoiceConsoleSettings {
  const wake = normalizeVoiceWakeSettings(value);
  return {
    ...wake,
    tts: normalizeCallTtsSettings(value?.tts ?? DEFAULT_VOICE_CONSOLE_SETTINGS.tts),
  };
}

export function loadVoiceConsoleSettings(): VoiceConsoleSettings {
  if (typeof window === "undefined" || !("localStorage" in window)) return DEFAULT_VOICE_CONSOLE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(VOICE_CONSOLE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_CONSOLE_SETTINGS;
    return normalizeVoiceConsoleSettings(JSON.parse(raw) as Partial<VoiceConsoleSettings>);
  } catch {
    return DEFAULT_VOICE_CONSOLE_SETTINGS;
  }
}

export function saveVoiceConsoleSettings(settings: VoiceConsoleSettings) {
  if (typeof window === "undefined" || !("localStorage" in window)) return;
  try {
    window.localStorage.setItem(VOICE_CONSOLE_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeVoiceConsoleSettings(settings)));
  } catch {
    // Voice UI settings persistence must not affect capture or playback.
  }
}
