import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../types";
import { ArtifactReaderModal, normalizedArtifactFontScale } from "./ArtifactReaderModal";

const artifact: Artifact = {
  id: "artifact-1",
  message_id: "message-1",
  channel_id: "channel-1",
  thread_root_id: null,
  creator_agent_id: "agent-1",
  creator_agent_handle: "writer",
  kind: "markdown",
  title: "Long report",
  summary: "Preview should not be repeated in the reader",
  content: "# Full report\n\nComplete content.",
  metadata: { source: "auto_long_message" },
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
};

const originalWindow = globalThis.window;

describe("ArtifactReaderModal", () => {
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
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  });

  it("uses 100% by default and applies controls only after commit", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<ArtifactReaderModal artifact={artifact} onClose={() => {}} />);
    });
    const reader = renderer!.root.find((node) => node.props.className === "artifact-reader");
    expect(reader.props.style["--artifact-reader-font-scale"]).toBe(1);
    const input = renderer!.root.findByProps({ "aria-label": "Font size percent" });

    await act(async () => {
      input.props.onChange({ target: { value: "150" } });
    });
    expect(reader.props.style["--artifact-reader-font-scale"]).toBe(1);

    await act(async () => {
      input.props.onBlur();
    });
    expect(renderer!.root.find((node) => node.props.className === "artifact-reader").props.style["--artifact-reader-font-scale"]).toBe(1.5);

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Decrease font size" }).props.onClick();
    });
    expect(renderer!.root.find((node) => node.props.className === "artifact-reader").props.style["--artifact-reader-font-scale"]).toBe(1.4);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(artifact.summary);
  });

  it("clamps and rounds submitted percentages", () => {
    expect(normalizedArtifactFontScale("5")).toBe(50);
    expect(normalizedArtifactFontScale("300")).toBe(250);
    expect(normalizedArtifactFontScale("119.6")).toBe(120);
    expect(normalizedArtifactFontScale("invalid")).toBe(100);
  });
});
