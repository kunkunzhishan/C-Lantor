import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LongMessageFallback,
  isLongMessageFallback,
  longMessageFallbackArtifact,
} from "./LongMessageFallback";

describe("LongMessageFallback", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("renders historical long messages as full-featured artifact cards", async () => {
    const body = Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n");
    let openedContent = "";
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <LongMessageFallback
          body={body}
          expanded={false}
          onToggle={() => {}}
          messageId="message-1"
          onOpenArtifact={(artifact) => {
            openedContent = artifact.content;
          }}
          renderBody={(value) => <pre>{value}</pre>}
        />,
      );
    });
    expect(isLongMessageFallback(body)).toBe(true);
    expect(longMessageFallbackArtifact(body).title).toBe("Line 1");
    expect(JSON.stringify(renderer!.toJSON())).toContain("30 lines");
    expect(renderer!.root.findAll((node) => node.props.className === "artifact-expanded-content")).toHaveLength(0);

    await act(async () => {
      const expand = renderer!.root.findAllByType("button").find((button) => button.children.includes("Expand"));
      expand?.props.onClick();
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Line 30");
    expect(renderer!.root.findAll((node) => node.props.className === "artifact-expanded-content")).toHaveLength(1);

    await act(async () => {
      const open = renderer!.root.findAllByType("button").find((button) => button.children.includes("Open"));
      open?.props.onClick();
    });
    expect(openedContent).toContain("Line 30");
  });
});
