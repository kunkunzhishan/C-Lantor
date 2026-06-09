import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_CONSOLE_SETTINGS, normalizeVoiceWakeSettings } from "./voiceConsoleSettings";

describe("voice console settings", () => {
  it("uses default wake words only when the field is missing", () => {
    expect(normalizeVoiceWakeSettings({ mode: "wake_word" }).wakeWords)
      .toBe(DEFAULT_VOICE_CONSOLE_SETTINGS.wakeWords);
  });

  it("preserves an explicitly cleared wake words field while editing", () => {
    expect(normalizeVoiceWakeSettings({ mode: "wake_word", wakeWords: "" }).wakeWords).toBe("");
  });
});
