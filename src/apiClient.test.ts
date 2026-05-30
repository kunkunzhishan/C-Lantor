import { describe, expect, it } from "vitest";
import { canOpenToolBrowserTarget, toolBrowserTargetFromHref, type ToolBrowserWindowInfo } from "./apiClient";

describe("Tool Browser frontend target validation", () => {
  it("matches the backend camelCase window info shape", () => {
    const info = {
      label: "tool-browser",
      url: "http://localhost:5173/tool-output?run=1",
      host: "localhost",
      isLoopback: true,
      created: true,
    } satisfies ToolBrowserWindowInfo;

    expect(info.isLoopback).toBe(true);
  });

  it("accepts absolute http and https URLs", () => {
    expect(toolBrowserTargetFromHref(" http://localhost:5173/tool-output?run=1#preview ")).toBe(
      "http://localhost:5173/tool-output?run=1#preview",
    );
    expect(toolBrowserTargetFromHref("https://example.com/report")).toBe("https://example.com/report");
  });

  it("rejects targets the backend command will reject", () => {
    expect(canOpenToolBrowserTarget("/artifact/123")).toBe(false);
    expect(canOpenToolBrowserTarget("localhost:5173")).toBe(false);
    expect(canOpenToolBrowserTarget("file:///tmp/report.html")).toBe(false);
    expect(canOpenToolBrowserTarget("javascript:alert(1)")).toBe(false);
    expect(canOpenToolBrowserTarget("https://user:pass@example.com")).toBe(false);
    expect(canOpenToolBrowserTarget("https://example.com/\nnext")).toBe(false);
  });

  it("rejects targets longer than the backend command limit", () => {
    const maxLengthTarget = `https://example.com/${"a".repeat(4076)}`;
    const tooLongTarget = `https://example.com/${"a".repeat(4077)}`;

    expect(maxLengthTarget).toHaveLength(4096);
    expect(tooLongTarget).toHaveLength(4097);
    expect(canOpenToolBrowserTarget(maxLengthTarget)).toBe(true);
    expect(canOpenToolBrowserTarget(tooLongTarget)).toBe(false);
  });
});
