import { describe, expect, it } from "vitest";
import { EMPTY_AGENT_FORM, normalizedReasoningEffortForRuntime } from "./types";
import { presetPrompt } from "./ui-utils";

describe("runtime reasoning effort normalization", () => {
  it("clamps Codex-only effort when switching to Claude", () => {
    expect(normalizedReasoningEffortForRuntime("claude", "xhigh")).toBe("medium");
    expect(normalizedReasoningEffortForRuntime("claude", "high")).toBe("high");
    expect(normalizedReasoningEffortForRuntime("codex", "xhigh")).toBe("xhigh");
  });
});

describe("presetPrompt", () => {
  it("lists the run-read context tool", () => {
    const prompt = presetPrompt({ ...EMPTY_AGENT_FORM, handle: "tester" });

    expect(prompt).toContain("--agent-context-tool run-read --run-id");
  });
});
