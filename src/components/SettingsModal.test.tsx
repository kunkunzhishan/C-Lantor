import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TEXT_SIZE_OPTIONS, type ChatTextSize } from "../chatTextSize";
import { SettingsModal } from "./SettingsModal";

const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalWindow = globalThis.window;

function renderSettings(
  chatTextSize: ChatTextSize,
  onChatTextSizeChange = vi.fn(),
) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <SettingsModal
        open
        chatTextSize={chatTextSize}
        onChatTextSizeChange={onChatTextSizeChange}
        onClose={vi.fn()}
      />,
    );
  });
  return { renderer, onChatTextSizeChange };
}

describe("SettingsModal text size", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("renders four text-size choices with the selected level pressed", () => {
    const { renderer } = renderSettings("large");
    const textSizeButtons = renderer.root.findAllByType("button").filter((button) => (
      typeof button.props["aria-pressed"] === "boolean"
    ));

    expect(textSizeButtons).toHaveLength(CHAT_TEXT_SIZE_OPTIONS.length);
    expect(textSizeButtons.map((button) => button.findByType("strong").children.join("")))
      .toEqual(["Small", "Default", "Large", "Extra"]);
    expect(textSizeButtons.map((button) => button.props["aria-pressed"]))
      .toEqual([false, false, true, false]);
  });

  it("emits the selected four-level text-size value", () => {
    const { renderer, onChatTextSizeChange } = renderSettings("default");
    const extraButton = renderer.root.findAllByType("button").find((button) => (
      button.findAllByType("strong").some((label) => label.children.join("") === "Extra")
    ));
    if (!extraButton) throw new Error("Extra text-size button not found");

    act(() => {
      extraButton.props.onClick();
    });

    expect(onChatTextSizeChange).toHaveBeenCalledTimes(1);
    expect(onChatTextSizeChange).toHaveBeenCalledWith("xlarge");
  });
});
