import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "../types";
import {
  MessageArtifacts,
  isAutoLongMessageArtifact,
  isLongMessageFallbackArtifact,
} from "./MessageArtifacts";

const artifact: Artifact = {
  id: "artifact-1",
  message_id: "message-1",
  channel_id: "channel-1",
  thread_root_id: null,
  creator_agent_id: "agent-1",
  creator_agent_handle: "writer",
  kind: "markdown",
  title: "Runtime report",
  summary: "**Compact** preview",
  content: "# Runtime report\n\nFull content",
  metadata: {
    source: "auto_long_message",
    line_count: 42,
    char_count: 8_500,
    code_block_count: 2,
  },
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
};

describe("MessageArtifacts", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("recognizes auto long-message artifacts and keeps the full body collapsed", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<MessageArtifacts artifacts={[artifact]} />);
    });

    expect(isAutoLongMessageArtifact(artifact)).toBe(true);
    expect(renderer!.root.findAll((node) => node.props.className === "artifact-expanded-content")).toHaveLength(0);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Compact");
    expect(JSON.stringify(renderer!.toJSON())).toContain("8,500 characters");

    await act(async () => {
      const expand = renderer!.root.findAllByType("button").find((button) => button.children.includes("Expand"));
      expand?.props.onClick();
      await Promise.resolve();
    });
    expect(renderer!.root.findAll((node) => node.props.className === "artifact-expanded-content")).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Full content");
  });

  it("recognizes frontend fallback artifacts as long-message cards", () => {
    expect(isLongMessageFallbackArtifact({
      metadata: { source: "long_message_fallback" },
    })).toBe(true);
  });
});
