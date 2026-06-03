import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsModal, type RefreshMetricsSnapshot } from "./DiagnosticsModal";

const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalWindow = globalThis.window;

function metrics(overrides: Partial<RefreshMetricsSnapshot> = {}): RefreshMetricsSnapshot {
  return {
    startedAt: Date.now() - 90_000,
    bootstrapCount: 3,
    bootstrapByReason: {
      initial_load: 1,
      "backend_event:batch": 2,
    },
    bootstrapBySource: {
      startup: 1,
      backend_event: 2,
    },
    requestCount: 6,
    requestByReason: {
      "backend_event:message": 3,
      manual: 1,
      page_restore: 2,
    },
    coalescedRequestCount: 2,
    coalescedRequestByReason: {
      "backend_event:message": 2,
    },
    queuedRequestCount: 1,
    queuedRequestByReason: {
      page_restore: 1,
    },
    stateUpdateCount: 8,
    stateUpdateByReason: {
      message_delta: 5,
      "backend_event:ephemeral_batch": 3,
    },
    lastBootstrapAt: Date.now() - 5_000,
    lastBootstrapReason: "backend_event:batch",
    lastBootstrapDurationMs: 125.4,
    averageBootstrapDurationMs: 98.6,
    ...overrides,
  };
}

function renderModal(props: Partial<React.ComponentProps<typeof DiagnosticsModal>> = {}) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <DiagnosticsModal
        open
        metrics={metrics()}
        onResetRefreshMetrics={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />,
    );
  });
  return renderer;
}

function visibleText(renderer: ReactTestRenderer) {
  const parts: string[] = [];
  function walk(node: unknown) {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    const children = (node as { children?: unknown[] }).children;
    children?.forEach(walk);
  }
  walk(renderer.toJSON());
  return parts.join("");
}

function findResetButton(renderer: ReactTestRenderer) {
  const button = renderer.root.findAllByType("button").find((node) => (
    node.props["aria-label"] === "Reset refresh metrics"
  ));
  if (!button) throw new Error("Reset refresh metrics button not found");
  return button;
}

describe("DiagnosticsModal", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T03:00:00.000Z"));
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("renders refresh counts, rates, reasons, and the browser debug object name", () => {
    const renderer = renderModal();
    const text = visibleText(renderer);

    expect(text).toContain("UI refresh metrics");
    expect(text).toContain("window.__LANTOR_REFRESH_METRICS__");
    expect(text).toContain("3");
    expect(text).toContain("2/min");
    expect(text).toContain("99ms");
    expect(text).toContain("125ms");
    expect(text).toContain("6");
    expect(text).toContain("2");
    expect(text).toContain("1");
    expect(text).toContain("8");
    expect(text).toContain("Running 1m 30s");
    expect(text).toContain("Last full refresh:");
    expect(text).toContain("backend_event:batch");
    expect(text).toContain("backend_event:message");
    expect(text).toContain("message_delta");
  });

  it("shows empty diagnostic state and invokes reset", () => {
    const onResetRefreshMetrics = vi.fn();
    const renderer = renderModal({
      metrics: metrics({
        bootstrapCount: 0,
        bootstrapByReason: {},
        bootstrapBySource: {},
        requestCount: 0,
        requestByReason: {},
        coalescedRequestCount: 0,
        coalescedRequestByReason: {},
        queuedRequestCount: 0,
        queuedRequestByReason: {},
        stateUpdateCount: 0,
        stateUpdateByReason: {},
        lastBootstrapAt: null,
        lastBootstrapReason: null,
        lastBootstrapDurationMs: null,
        averageBootstrapDurationMs: null,
      }),
      onResetRefreshMetrics,
    });

    const text = visibleText(renderer);
    expect(text.match(/No events yet\./g)).toHaveLength(3);
    expect(text).toContain("Last full refresh:");
    expect(text).toContain("none");

    act(() => {
      findResetButton(renderer).props.onClick();
    });

    expect(onResetRefreshMetrics).toHaveBeenCalledTimes(1);
  });
});
