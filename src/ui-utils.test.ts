import { describe, expect, it } from "vitest";
import {
  EMPTY_AGENT_FORM,
  isCodexLikeRuntime,
  modelOptionsFromCatalog,
  normalizedReasoningEffortForRuntime,
} from "./types";
import { buildPresetCommand, presetPrompt } from "./ui-utils";

describe("runtime reasoning effort normalization", () => {
  it("clamps Codex-only effort when switching to Claude", () => {
    expect(normalizedReasoningEffortForRuntime("claude", "xhigh")).toBe("medium");
    expect(normalizedReasoningEffortForRuntime("claude", "high")).toBe("high");
    expect(normalizedReasoningEffortForRuntime("codex", "xhigh")).toBe("xhigh");
    expect(normalizedReasoningEffortForRuntime("traex", "xhigh")).toBe("xhigh");
  });
});

describe("dynamic runtime models", () => {
  it("includes new Codex models in static fallbacks", () => {
    expect(modelOptionsFromCatalog("codex")).toContain("gpt-5.6-sol");
    expect(modelOptionsFromCatalog("traex")).toContain("gpt-5.6-sol");
  });

  it("uses catalog models before static fallbacks", () => {
    const models = modelOptionsFromCatalog("codex", "", [{
      runtime: "codex",
      command: "codex",
      default_model: "gpt-5.6-sol",
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "" }],
      source: "runtime",
      error: null,
      fetched_at: "2026-07-28T00:00:00Z",
      expires_at: "2026-07-28T00:10:00Z",
    }]);

    expect(models).toEqual(["gpt-5.6-sol"]);
  });

  it("builds Traex commands with Codex-like options", () => {
    const command = buildPresetCommand({
      ...EMPTY_AGENT_FORM,
      runtime: "traex",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    });

    expect(isCodexLikeRuntime("traex")).toBe(true);
    expect(command).toContain("traex exec --model 'gpt-5.5'");
    expect(command).toContain("model_reasoning_effort=\"xhigh\"");
    expect(command).toContain("service_tier=\"fast\"");
  });
});

describe("presetPrompt", () => {
  it("lists the run-read context tool", () => {
    const prompt = presetPrompt({ ...EMPTY_AGENT_FORM, handle: "tester" });

    expect(prompt).toContain("--agent-context-tool run-read --run-id");
  });
});
