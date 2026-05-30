import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../apiClient";
import { TOOL_BROWSER_TOGGLE_EVENT } from "../toolBrowserEvents";
import { MessageMarkdown } from "./MessageMarkdown";

vi.mock("../apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apiClient")>();
  return {
    ...actual,
    openExternalUrl: vi.fn(),
  };
});

const openExternalUrlMock = vi.mocked(openExternalUrl);
const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalWindow = globalThis.window;

function findToolBrowserButton(renderer: ReactTestRenderer) {
  const button = renderer.root.findAllByType("button").find((node) => (
    node.props["aria-label"] === "Toggle embedded browser"
  ));
  if (!button) throw new Error("Tool Browser button not found");
  return button;
}

describe("MessageMarkdown Tool Browser links", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: vi.fn(),
      },
    });
    openExternalUrlMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("renders a Tool Browser button for markdown http links and toggles the embedded browser target", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MessageMarkdown body="Review [report]( https://example.com/report#summary )." />);
    });

    const button = findToolBrowserButton(renderer!);
    expect(renderer!.root.findByType("a").props.href).toBe("https://example.com/report#summary");
    expect(button.findByType("span").children).toEqual(["Open in app"]);

    await act(async () => {
      button.props.onClick({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      });
      await Promise.resolve();
    });

    const dispatchEvent = vi.mocked(window.dispatchEvent);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent<{ target: string }>;
    expect(event.type).toBe(TOOL_BROWSER_TOGGLE_EVENT);
    expect(event.detail.target).toBe("https://example.com/report#summary");
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });

  it("does not render the Tool Browser button for unsupported link schemes", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MessageMarkdown body="Review [report](mailto:team@example.com)." />);
    });

    expect(renderer!.root.findAllByType("button").filter((node) => (
      node.props["aria-label"] === "Toggle embedded browser"
    ))).toHaveLength(0);
  });
});
