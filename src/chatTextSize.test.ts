import { describe, expect, it } from "vitest";
import {
  CHAT_TEXT_SIZE_OPTIONS,
  CHAT_TEXT_SIZE_STORAGE_KEY,
  CHAT_TEXT_SIZE_STYLES,
  stepChatTextSize,
  storedChatTextSize,
} from "./chatTextSize";

function storage(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem(key: string) {
      return key === CHAT_TEXT_SIZE_STORAGE_KEY ? value : null;
    },
  };
}

describe("chat text size preferences", () => {
  it("defines the four upstream text-size levels and CSS variable scale", () => {
    expect(CHAT_TEXT_SIZE_OPTIONS).toEqual(["compact", "default", "large", "xlarge"]);
    expect(CHAT_TEXT_SIZE_STYLES.compact["--type-size-message"]).toBe("14px");
    expect(CHAT_TEXT_SIZE_STYLES.default["--type-size-message"]).toBe("15px");
    expect(CHAT_TEXT_SIZE_STYLES.large["--type-size-message"]).toBe("16px");
    expect(CHAT_TEXT_SIZE_STYLES.xlarge["--type-size-message"]).toBe("18px");
  });

  it("loads only valid stored text-size values", () => {
    expect(storedChatTextSize(storage("large"))).toBe("large");
    expect(storedChatTextSize(storage("huge"))).toBe("default");
    expect(storedChatTextSize(storage(null))).toBe("default");
  });

  it("steps through text-size levels and clamps at the ends", () => {
    expect(stepChatTextSize("default", 1)).toBe("large");
    expect(stepChatTextSize("large", 1)).toBe("xlarge");
    expect(stepChatTextSize("xlarge", 1)).toBe("xlarge");
    expect(stepChatTextSize("default", -1)).toBe("compact");
    expect(stepChatTextSize("compact", -1)).toBe("compact");
  });
});
