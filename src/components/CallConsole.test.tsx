import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiInvoke } from "../apiClient";
import { useCallModeRecorder } from "../hooks/useCallModeRecorder";
import { useCallModeSubmit } from "../hooks/useCallModeSubmit";
import type { Agent, AgentWorkItem, CallDispatch, CallSession, CallUtterance, CallUtteranceSubmitResult, Channel, Message } from "../types";
import { CallConsole } from "./CallConsole";

vi.mock("../apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apiClient")>();
  return {
    ...actual,
    apiInvoke: vi.fn(async () => []),
    closeToolBrowser: vi.fn(async () => undefined),
    focusToolBrowser: vi.fn(async () => undefined),
    isTauriRuntime: vi.fn(() => false),
    openExternalUrl: vi.fn(async () => undefined),
    openToolBrowser: vi.fn(async () => ({
      label: "tool-browser",
      url: "https://example.com/report",
      host: "example.com",
      isLoopback: false,
      created: true,
    })),
    retargetToolBrowser: vi.fn(async () => ({
      label: "tool-browser",
      url: "https://example.com/report",
      host: "example.com",
      isLoopback: false,
      created: false,
    })),
  };
});

vi.mock("../hooks/useAutoGrowTextarea", () => ({
  useAutoGrowTextarea: vi.fn(),
}));

vi.mock("../hooks/useHybridVoiceInput", () => ({
  useHybridVoiceInput: () => ({
    abort: vi.fn(),
    error: null,
    isListening: false,
    isRecordedInput: false,
    isRequestingPermission: false,
    isStarting: false,
    isSupported: true,
    isTranscribing: false,
    recordingElapsedMs: 0,
    start: vi.fn(),
    statusMessage: "",
    stop: vi.fn(),
  }),
}));

vi.mock("../hooks/useCallModeSubmit", () => ({
  useCallModeSubmit: vi.fn(),
}));

vi.mock("../hooks/useCallModeRecorder", () => ({
  useCallModeRecorder: vi.fn(),
}));

const useCallModeSubmitMock = vi.mocked(useCallModeSubmit);
const useCallModeRecorderMock = vi.mocked(useCallModeRecorder);
const apiInvokeMock = vi.mocked(apiInvoke);

const channel: Channel = {
  id: "channel-1",
  name: "ops",
  description: "Operations",
  kind: "channel",
  dm_agent_id: null,
  unread_count: 0,
};

const adaAgent: Agent = {
  id: "agent-1",
  handle: "ada",
  display_name: "Ada",
  role: "worker",
  status: "idle",
  runtime: "codex",
  model: "gpt",
  reasoning_effort: "medium",
  service_tier: "auto",
  avatar: "",
  description: "",
  launch_command: "",
  working_directory: "",
  workspace_exists: false,
  workspace_memory_path: "",
  workspace_memory_exists: false,
  workspace_entries: [],
  daily_budget_micros: 0,
};

const activeSession = {
  id: "call-session-1",
  channel_id: null,
  thread_root_id: null,
  status: "active",
  title: "Call",
  started_at: "2026-05-24T00:00:00.000Z",
  ended_at: null,
  updated_at: "2026-05-24T00:00:01.000Z",
} as const;

const endedSession: CallSession = {
  id: "call-session-ended",
  channel_id: null,
  thread_root_id: null,
  status: "ended",
  title: "Previous Call",
  started_at: "2026-05-23T23:58:00.000Z",
  ended_at: "2026-05-23T23:59:00.000Z",
  updated_at: "2026-05-23T23:59:00.000Z",
};

const submitResult: CallUtteranceSubmitResult = {
  session: activeSession,
  utterance: {
    id: "utterance-1",
    session_id: "call-session-1",
    thread_root_utterance_id: null,
    sequence: 1,
    transcript: "ship it",
    language: "en-US",
    transcription_provider: "openai",
    transcription_error: "",
    audio_mime_type: "audio/webm",
    audio_original_name: "call.webm",
    audio_duration_ms: 1200,
    status: "dispatched",
    created_at: "2026-05-24T00:00:01.000Z",
    updated_at: "2026-05-24T00:00:02.000Z",
  },
  dispatch: {
    id: "dispatch-1",
    session_id: "call-session-1",
    utterance_id: "utterance-1",
    utterance_sequence: 1,
    intent: "delegate",
    ack_status: "understood",
    ack_text: "Heard.",
    speech_topic: "",
    confidence: "high",
    target_agent_id: null,
    work_item_id: null,
    compensated_work_item_id: null,
    long_task_id: null,
    status: "acknowledged",
    outcome: "acknowledged_pending_work",
    status_text: "Acknowledged",
    correlation_key: "call-session-1:1",
    correlation_trail: [],
    error: "",
    created_at: "2026-05-24T00:00:02.000Z",
    updated_at: "2026-05-24T00:00:02.000Z",
  },
  ack_text: "Heard.",
  work_item_id: null,
  long_task_id: null,
};

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalSpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;
const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let speechSpeak: ReturnType<typeof vi.fn>;
let speechCancel: ReturnType<typeof vi.fn>;

function baseCallConsoleProps(): React.ComponentProps<typeof CallConsole> {
  return {
    agentWorkItems: [],
    agents: [],
    callDispatches: [],
    callSessions: [],
    callUtterances: [],
    ownerProfile: {
      display_name: "c.c.",
      avatar: "dicebear:dylan:owner",
      description: "local owner",
    },
    activeCallThreadId: null,
    setActiveCallThreadId: vi.fn(),
    loadOlderCallHistory: vi.fn(async () => 0),
    onOpenWorkItem: vi.fn(),
    openMobileSidebar: vi.fn(),
    messages: [],
  };
}

function mockCallModeState(overrides: Partial<ReturnType<typeof useCallModeSubmit>> = {}) {
  useCallModeSubmitMock.mockReturnValue({
    cancelWork: vi.fn(async () => submitResult),
    error: null,
    isControllingWork: false,
    isLive: true,
    isResolvingConfirmation: false,
    isStarting: false,
    isStopping: false,
    isSubmitting: false,
    lastResult: null,
    resolveConfirmation: vi.fn(async () => submitResult),
    session: activeSession,
    start: vi.fn(async () => activeSession),
    stop: vi.fn(async () => activeSession),
    submitRecordedUtterance: vi.fn(async () => submitResult),
    submitTypedUtterance: vi.fn(async () => submitResult),
    submitResults: [],
    ...overrides,
  });
}

function mockRecorderState(overrides: Partial<ReturnType<typeof useCallModeRecorder>> = {}) {
  useCallModeRecorderMock.mockReturnValue({
    cancel: vi.fn(),
    error: null,
    flushAndStop: vi.fn(async () => undefined),
    isListening: true,
    isMuted: false,
    isRecording: true,
    isRequestingPermission: false,
    isStopping: false,
    isSubmittingAudio: false,
    isSupported: true,
    isVoiceActive: false,
    lastAudioBytes: null,
    lastDurationMs: null,
    limits: {
      maxAudioBytes: 25_000_000,
      maxDurationMs: 60_000,
      segmentMs: 6_000,
    },
    mute: vi.fn(),
    pendingSubmitCount: 0,
    recordingElapsedMs: 0,
    recordingStartedAt: Date.now(),
    start: vi.fn(async () => undefined),
    status: "listening",
    statusMessage: "Listening...",
    unmute: vi.fn(),
    ...overrides,
  });
}

function findButtonByLabel(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((node) => node.props["aria-label"] === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function findInputByLabel(renderer: ReactTestRenderer, label: string) {
  const input = [
    ...renderer.root.findAllByType("input"),
    ...renderer.root.findAllByType("textarea"),
  ].find((node) => node.props["aria-label"] === label);
  if (!input) throw new Error(`Input not found: ${label}`);
  return input;
}

function workerReplyMessage(id: string, workItem: AgentWorkItem, body: string, createdAt: string): Message {
  return {
    id,
    channel_id: channel.id,
    thread_root_id: null,
    sender_agent_id: workItem.agent_id,
    sender_name: "Ada",
    sender_role: "agent",
    body,
    is_task: false,
    thread_followed: true,
    delivery_state: "complete",
    stream_key: `${workItem.id}:worker-reply:${id}`,
    task_number: null,
    task_status: null,
    attachments: [],
    artifacts: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function sequencedSubmitResult(sequence: number, ackText: string): CallUtteranceSubmitResult {
  return {
    ...submitResult,
    utterance: {
      ...submitResult.utterance,
      id: `utterance-${sequence}`,
      sequence,
      transcript: `utterance ${sequence}`,
    },
    dispatch: {
      ...submitResult.dispatch,
      id: `dispatch-${sequence}`,
      utterance_id: `utterance-${sequence}`,
      utterance_sequence: sequence,
      ack_text: ackText,
    },
    ack_text: ackText,
  };
}

describe("Call Console controls", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    speechSpeak = vi.fn();
    speechCancel = vi.fn();
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: class {
        lang = "";
        text: string;

        constructor(text: string) {
          this.text = text;
        }
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        cancelAnimationFrame: vi.fn(),
        clearInterval: globalThis.clearInterval,
        clearTimeout: globalThis.clearTimeout,
        getSelection: vi.fn(() => ({ toString: () => "" })),
        localStorage: {
          getItem: vi.fn(() => JSON.stringify({
            tts: { provider: "browser", language: "zh-CN", voice: "browser-auto", rate: 1 },
          })),
          setItem: vi.fn(),
        },
        matchMedia: vi.fn(() => ({ matches: false })),
        removeEventListener: vi.fn(),
        requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        }),
        setInterval: globalThis.setInterval,
        setTimeout: globalThis.setTimeout,
        speechSynthesis: {
          cancel: speechCancel,
          speak: speechSpeak,
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        activeElement: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    useCallModeSubmitMock.mockReset();
    useCallModeRecorderMock.mockReset();
    apiInvokeMock.mockReset();
    apiInvokeMock.mockResolvedValue([]);
    mockCallModeState();
    mockRecorderState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalDocument === undefined) delete (globalThis as Partial<typeof globalThis>).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    if (originalSpeechSynthesisUtterance === undefined) {
      delete (globalThis as Partial<typeof globalThis>).SpeechSynthesisUtterance;
    } else {
      Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
        configurable: true,
        value: originalSpeechSynthesisUtterance,
      });
    }
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("keeps voice configuration behind the Settings control", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const renderedVoice = JSON.stringify(renderer.toJSON());
    expect(renderedVoice).not.toContain("Assistant");
    expect(renderedVoice).not.toContain("No live work");
    expect(renderedVoice).not.toContain("Voice threads tracked");
    expect(renderedVoice).not.toContain("Call voice settings");
    expect(renderer.root.findByProps({ className: "call-header-actions" }).findAllByType("button")).toHaveLength(3);
    expect(renderer.root.findAllByProps({ "aria-label": "Voice settings" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "aria-label": "Call voice provider" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "aria-label": "Call wake words" })).toHaveLength(0);

    await act(async () => {
      findButtonByLabel(renderer, "Voice settings").props.onClick();
    });

    expect(renderer.root.findAllByProps({ "aria-label": "Voice settings panel" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "aria-label": "Call voice provider" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ "aria-label": "Call wake words" })).toHaveLength(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("defaults new Voice sessions to Wake Word mode", async () => {
    mockCallModeState({ isLive: false, session: null });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    expect(useCallModeSubmitMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: "wake_word",
      wakeWords: "兰托, 蓝托, Lantor",
    }));
    expect(() => findButtonByLabel(renderer, "Start Wake Word Mode")).not.toThrow();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("uses the live backend session mode for Voice labels while a call is active", async () => {
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => key === "lantor.voiceConsoleSettings"
          ? JSON.stringify({ mode: "wake_word", wakeWords: "小美" })
          : null),
        setItem: vi.fn(),
      },
    });
    mockCallModeState({
      session: {
        ...activeSession,
        mode: "call",
        wake_words: "兰托,蓝托,Lantor",
      },
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    expect(() => findButtonByLabel(renderer, "End Call Mode")).not.toThrow();
    expect(() => findButtonByLabel(renderer, "End Wake Word Mode")).toThrow();

    await act(async () => {
      findButtonByLabel(renderer, "Voice settings").props.onClick();
    });

    const modeGroup = renderer.root.findByProps({ "aria-label": "Call console mode" });
    const [callButton, wakeWordButton] = modeGroup.findAllByType("button");
    expect(callButton.props["aria-pressed"]).toBe(true);
    expect(wakeWordButton.props["aria-pressed"]).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("updates TTS provider settings while Voice is live", async () => {
    const setItem = vi.fn();
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => key === "lantor.voiceConsoleSettings"
          ? JSON.stringify({
            mode: "wake_word",
            wakeWords: "小美",
            tts: { provider: "browser", language: "zh-CN", voice: "browser-auto", rate: 1 },
          })
          : null),
        setItem,
      },
    });
    mockCallModeState({
      isLive: true,
      session: {
        ...activeSession,
        mode: "wake_word",
        wake_words: "小美",
      },
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });
    await act(async () => {
      findButtonByLabel(renderer, "Voice settings").props.onClick();
    });

    const providerGroup = renderer.root.findByProps({ "aria-label": "Call voice provider" });
    const [browserButton, edgeButton] = providerGroup.findAllByType("button");
    expect(browserButton.props["aria-pressed"]).toBe(true);
    expect(edgeButton.props["aria-pressed"]).toBe(false);

    await act(async () => {
      edgeButton.props.onClick();
    });

    expect(browserButton.props["aria-pressed"]).toBe(false);
    expect(edgeButton.props["aria-pressed"]).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      "lantor.voiceConsoleSettings",
      expect.stringContaining("\"provider\":\"edge\""),
    );

    await act(async () => {
      renderer.unmount();
    });
  });

  it("blocks end-call and mute actions while recorder final audio is flushing", async () => {
    const stop = vi.fn(async () => activeSession);
    const flushAndStop = vi.fn(async () => undefined);
    const mute = vi.fn();
    mockCallModeState({ stop });
    mockRecorderState({ flushAndStop, isStopping: true, mute, statusMessage: "Ending call; sending last captured utterance..." });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const endCallButton = findButtonByLabel(renderer, "End Call Mode");
    const muteButton = findButtonByLabel(renderer, "Mute microphone");

    expect(endCallButton.props.disabled).toBe(true);
    expect(muteButton.props.disabled).toBe(true);

    await act(async () => {
      endCallButton.props.onClick();
      muteButton.props.onClick();
    });

    expect(flushAndStop).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(mute).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("allows the normal end-call path when recorder is not finalizing", async () => {
    const stop = vi.fn(async () => activeSession);
    const flushAndStop = vi.fn(async () => undefined);
    mockCallModeState({ stop });
    mockRecorderState({ flushAndStop });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const endCallButton = findButtonByLabel(renderer, "End Call Mode");

    expect(endCallButton.props.disabled).toBe(false);

    await act(async () => {
      await endCallButton.props.onClick();
    });

    expect(flushAndStop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(speechCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks a final call acknowledgement flushed while ending the call", async () => {
    const endedActiveSession: CallSession = {
      ...activeSession,
      status: "ended",
      ended_at: "2026-05-24T00:00:05.000Z",
      updated_at: "2026-05-24T00:00:05.000Z",
    };
    const finalResult: CallUtteranceSubmitResult = {
      ...sequencedSubmitResult(1, "可以。你要打开哪个 B 站页面或链接？"),
      session: endedActiveSession,
      dispatch: {
        ...sequencedSubmitResult(1, "可以。你要打开哪个 B 站页面或链接？").dispatch,
        intent: "clarify",
        ack_status: "needs_target",
        status: "needs_user",
        outcome: "needs_user",
        status_text: "Needs user clarification.",
        error: "coordinator requested clarification",
      },
      ack_text: "可以。你要打开哪个 B 站页面或链接？",
    };
    const props = baseCallConsoleProps();
    const stop = vi.fn(async () => endedActiveSession);
    let renderer!: ReactTestRenderer;
    const flushAndStop = vi.fn(async () => {
      mockCallModeState({
        isLive: false,
        session: endedActiveSession,
        stop,
        submitResults: [finalResult],
      });
      renderer.update(<CallConsole {...props} />);
    });
    mockCallModeState({ stop });
    mockRecorderState({ flushAndStop });

    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    await act(async () => {
      await findButtonByLabel(renderer, "End Call Mode").props.onClick();
    });

    expect(flushAndStop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "可以。你要打开哪个 B 站页面或链接？",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("submits typed Call Mode speech through the live call hook", async () => {
    const submitTypedUtterance = vi.fn(async () => submitResult);
    mockCallModeState({ submitTypedUtterance });
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    const input = findInputByLabel(renderer, "Type to simulate Call Mode speech");

    await act(async () => {
      input.props.onChange({ currentTarget: { value: "please dispatch this" } });
    });

    const form = renderer.root.findByProps({ className: "composer call-mode-typed-utterance" });
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(submitTypedUtterance).toHaveBeenCalledWith({ transcript: "please dispatch this" });
    expect(findInputByLabel(renderer, "Type to simulate Call Mode speech").props.value).toBe("");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("submits typed Call Mode speech with Enter", async () => {
    const submitTypedUtterance = vi.fn(async () => submitResult);
    mockCallModeState({ submitTypedUtterance });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const input = findInputByLabel(renderer, "Type to simulate Call Mode speech");
    const preventDefault = vi.fn();

    await act(async () => {
      input.props.onChange({ currentTarget: { value: "send from enter" } });
    });
    await act(async () => {
      await findInputByLabel(renderer, "Type to simulate Call Mode speech").props.onKeyDown({
        key: "Enter",
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        nativeEvent: { isComposing: false },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(submitTypedUtterance).toHaveBeenCalledWith({ transcript: "send from enter" });
    expect(findInputByLabel(renderer, "Type to simulate Call Mode speech").props.value).toBe("");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps the Voice text composer editable while call audio is submitting", async () => {
    const submitTypedUtterance = vi.fn(async () => submitResult);
    mockCallModeState({ isSubmitting: true, submitTypedUtterance });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const input = findInputByLabel(renderer, "Type to simulate Call Mode speech");
    expect(input.props.disabled).toBe(false);

    await act(async () => {
      input.props.onChange({ currentTarget: { value: "typed while muted audio flushes" } });
    });

    expect(findInputByLabel(renderer, "Type to simulate Call Mode speech").props.value)
      .toBe("typed while muted audio flushes");
    expect(findButtonByLabel(renderer, "Submit typed Call Mode speech").props.disabled).toBe(false);

    const form = renderer.root.findByProps({ className: "composer call-mode-typed-utterance" });
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(submitTypedUtterance).toHaveBeenCalledWith({ transcript: "typed while muted audio flushes" });
    expect(findInputByLabel(renderer, "Type to simulate Call Mode speech").props.value).toBe("");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("submits Voice thread replies against the active thread root", async () => {
    const submitTypedUtterance = vi.fn(async () => ({
      ...submitResult,
      utterance: {
        ...submitResult.utterance,
        id: "utterance-thread-reply",
        sequence: 2,
        transcript: "continue here",
        thread_root_utterance_id: submitResult.utterance.id,
      },
    }));
    mockCallModeState({ submitTypedUtterance });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={submitResult.utterance.id}
        callUtterances={[submitResult.utterance]}
        callDispatches={[submitResult.dispatch]}
      />);
    });

    const input = findInputByLabel(renderer, "Reply to Voice thread 1");
    await act(async () => {
      input.props.onChange({ currentTarget: { value: " continue here " } });
    });
    const form = renderer.root.findByProps({ className: "reply-composer call-thread-reply-composer" });
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(submitTypedUtterance).toHaveBeenCalledWith({
      transcript: "continue here",
      threadRootUtteranceId: submitResult.utterance.id,
    });
    expect(findInputByLabel(renderer, "Reply to Voice thread 1").props.value).toBe("");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps the Voice thread reply composer editable while call audio is submitting", async () => {
    const submitTypedUtterance = vi.fn(async () => submitResult);
    mockCallModeState({ isSubmitting: true, submitTypedUtterance });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={submitResult.utterance.id}
        callUtterances={[submitResult.utterance]}
        callDispatches={[submitResult.dispatch]}
      />);
    });

    const input = findInputByLabel(renderer, "Reply to Voice thread 1");
    expect(input.props.disabled).toBe(false);

    await act(async () => {
      input.props.onChange({ currentTarget: { value: "thread reply while audio flushes" } });
    });

    expect(findInputByLabel(renderer, "Reply to Voice thread 1").props.value)
      .toBe("thread reply while audio flushes");
    expect(findButtonByLabel(renderer, "Submit reply to Voice thread 1").props.disabled).toBe(false);

    const form = renderer.root.findByProps({ className: "reply-composer call-thread-reply-composer" });
    await act(async () => {
      await form.props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(submitTypedUtterance).toHaveBeenCalledWith({
      transcript: "thread reply while audio flushes",
      threadRootUtteranceId: submitResult.utterance.id,
    });
    expect(findInputByLabel(renderer, "Reply to Voice thread 1").props.value).toBe("");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks call ACKs in utterance order even when submit results arrive out of order", async () => {
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const firstResult = sequencedSubmitResult(
      1,
      "First acknowledgement should stay short. This extra sentence should not be spoken because phone call replies must stay compact.",
    );
    const secondResult = sequencedSubmitResult(2, "Second acknowledgement.");
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    mockCallModeState({ submitResults: [secondResult] });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    mockCallModeState({ submitResults: [secondResult, firstResult] });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "First acknowledgement should stay short. This extra sentence should not be spoken because phone call replies must stay compact.",
      lang: "zh-CN",
    });

    await act(async () => {
      speechSpeak.mock.calls[0][0].onend();
      vi.advanceTimersByTime(1000);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(2);
    expect(speechSpeak.mock.calls[1][0]).toMatchObject({ text: "Second acknowledgement." });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not let ignored no-speech turns block later ACK speech", async () => {
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const firstResult = sequencedSubmitResult(1, "First acknowledgement.");
    const ignoredResult: CallUtteranceSubmitResult = {
      ...sequencedSubmitResult(2, ""),
      utterance: {
        ...sequencedSubmitResult(2, "").utterance,
        transcript: "",
        transcription_error: "providerFailed: No speech detected",
        status: "ignored",
      },
      dispatch: {
        ...sequencedSubmitResult(2, "").dispatch,
        ack_text: "这段没有检测到说话，我先忽略了。",
        error: "providerFailed: No speech detected",
        status: "ignored",
        outcome: "ignored",
      },
      ack_text: "这段没有检测到说话，我先忽略了。",
    };
    const thirdResult = sequencedSubmitResult(3, "Third acknowledgement.");
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    mockCallModeState({ submitResults: [firstResult, ignoredResult, thirdResult] });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "First acknowledgement." });

    await act(async () => {
      speechSpeak.mock.calls[0][0].onend();
      vi.advanceTimersByTime(1000);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(2);
    expect(speechSpeak.mock.calls[1][0]).toMatchObject({ text: "Third acknowledgement." });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not add source context to coordinator ACK speech", async () => {
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const firstResult = sequencedSubmitResult(1, "你好。");
    const secondResult = {
      ...sequencedSubmitResult(2, "Edge TTS 可以免费用。"),
      utterance: {
        ...sequencedSubmitResult(2, "Edge TTS 可以免费用。").utterance,
        transcript: "Edge TTS 免费吗",
      },
    };
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    mockCallModeState({ submitResults: [firstResult, secondResult] });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "你好。" });

    await act(async () => {
      speechSpeak.mock.calls[0][0].onend();
      vi.advanceTimersByTime(1000);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(2);
    expect(speechSpeak.mock.calls[1][0]).toMatchObject({ text: "Edge TTS 可以免费用。" });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("requeues interrupted assistant speech before later replies", async () => {
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    const firstResult = sequencedSubmitResult(1, "First answer.");
    const secondResult = {
      ...sequencedSubmitResult(2, "Edge TTS 可以免费用。"),
      utterance: {
        ...sequencedSubmitResult(2, "Edge TTS 可以免费用。").utterance,
        transcript: "Edge TTS 免费吗",
      },
    };
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    mockCallModeState({ submitResults: [firstResult, secondResult] });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });
    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "First answer." });

    mockRecorderState({ isVoiceActive: true });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });
    expect(speechCancel).toHaveBeenCalledTimes(2);
    expect(speechSpeak).toHaveBeenCalledTimes(1);

    mockRecorderState({ isVoiceActive: false });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(2);
    expect(speechSpeak.mock.calls[1][0]).toMatchObject({ text: "First answer." });
    expect(speechSpeak.mock.calls.map((call) => call[0].text)).toEqual([
      "First answer.",
      "First answer.",
    ]);

    await act(async () => {
      speechSpeak.mock.calls[1][0].onend();
      vi.advanceTimersByTime(1000);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(3);
    expect(speechSpeak.mock.calls[2][0]).toMatchObject({ text: "Edge TTS 可以免费用。" });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("only barge-interrupts wake-word mode speech after a wake-only acknowledgement", async () => {
    vi.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => key === "lantor.voiceConsoleSettings"
          ? JSON.stringify({ mode: "wake_word", wakeWords: "小美" })
          : null),
        setItem: vi.fn(),
      },
    });
    const firstResult = sequencedSubmitResult(1, "First answer.");
    const secondResult = sequencedSubmitResult(2, "Second answer.");
    const wakeAckBase = sequencedSubmitResult(3, "我在，您说。");
    const wakeAckResult: CallUtteranceSubmitResult = {
      ...wakeAckBase,
      session: {
        ...activeSession,
        mode: "wake_word",
        wake_words: "小美",
      },
      utterance: {
        ...wakeAckBase.utterance,
        transcript: "小美小美",
        status: "acknowledged",
      },
      dispatch: {
        ...wakeAckBase.dispatch,
        intent: "ack_only",
        status: "acknowledged",
        work_item_id: null,
      },
      work_item_id: null,
    };
    const props = baseCallConsoleProps();
    const wakeWordSession: CallSession = {
      ...activeSession,
      mode: "wake_word",
      wake_words: "小美",
    };

    let renderer!: ReactTestRenderer;
    mockCallModeState({ session: wakeWordSession, submitResults: [firstResult, secondResult] });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });
    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "First answer." });

    mockRecorderState({ isVoiceActive: true });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });
    expect(speechCancel).toHaveBeenCalledTimes(1);
    expect(speechSpeak).toHaveBeenCalledTimes(1);

    mockCallModeState({ session: wakeWordSession, submitResults: [firstResult, secondResult, wakeAckResult] });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });
    expect(speechSpeak).toHaveBeenCalledTimes(2);
    expect(speechSpeak.mock.calls[1][0]).toMatchObject({ text: "我在，您说。" });
    expect(speechCancel).toHaveBeenCalledTimes(3);

    await act(async () => {
      speechSpeak.mock.calls[1][0].onend();
      vi.advanceTimersByTime(1000);
    });
    expect(speechSpeak).toHaveBeenCalledTimes(3);
    expect(speechSpeak.mock.calls[2][0]).toMatchObject({ text: "Second answer." });

    await act(async () => {
      speechSpeak.mock.calls[2][0].onend();
      vi.advanceTimersByTime(1000);
    });
    expect(speechSpeak).toHaveBeenCalledTimes(3);
    expect(speechSpeak.mock.calls.map((call) => call[0].text)).toEqual([
      "First answer.",
      "我在，您说。",
      "Second answer.",
    ]);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("uses the selected Edge provider for wake-only acknowledgement barge-in speech", async () => {
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => key === "lantor.voiceConsoleSettings"
          ? JSON.stringify({
            mode: "wake_word",
            wakeWords: "小美",
            tts: { provider: "edge", language: "zh-CN", voice: "zh-CN-XiaoxiaoNeural", rate: 1 },
          })
          : null),
        setItem: vi.fn(),
      },
    });
    const originalAudio = globalThis.Audio;
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const audioPlay = vi.fn(async () => undefined);
    const audioPause = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:wake-edge-tts"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src: string;
        volume = 1;

        constructor(src: string) {
          this.src = src;
        }

        play = audioPlay;
        pause = audioPause;
      },
    });
    apiInvokeMock.mockResolvedValueOnce({
      provider: "edge",
      mime_type: "audio/mpeg",
      bytes: [1, 2, 3],
    });
    const wakeAckBase = sequencedSubmitResult(1, "我在，您说。");
    const wakeAckResult: CallUtteranceSubmitResult = {
      ...wakeAckBase,
      session: {
        ...activeSession,
        mode: "wake_word",
        wake_words: "小美",
      },
      utterance: {
        ...wakeAckBase.utterance,
        transcript: "小美小美",
        status: "acknowledged",
      },
      dispatch: {
        ...wakeAckBase.dispatch,
        intent: "ack_only",
        status: "acknowledged",
        work_item_id: null,
      },
      work_item_id: null,
    };
    const wakeWordSession: CallSession = {
      ...activeSession,
      mode: "wake_word",
      wake_words: "小美",
    };

    let renderer!: ReactTestRenderer;
    try {
      mockCallModeState({ session: wakeWordSession, submitResults: [wakeAckResult] });
      await act(async () => {
        renderer = create(<CallConsole {...baseCallConsoleProps()} />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(apiInvokeMock).toHaveBeenCalledWith("synthesize_tts_audio", expect.objectContaining({
        provider: "edge",
        text: "我在，您说。",
        voice: "zh-CN-XiaoxiaoNeural",
      }));
      expect(audioPlay).toHaveBeenCalledTimes(1);
      expect(speechSpeak).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      if (originalAudio === undefined) delete (globalThis as Partial<typeof globalThis>).Audio;
      else Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
      if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
      else delete (URL as Partial<typeof URL>).createObjectURL;
      if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
      else delete (URL as Partial<typeof URL>).revokeObjectURL;
    }
  });

  it("seeds ordered ACK speech from resumed call state", async () => {
    const historicalFirst = sequencedSubmitResult(1, "Historical first acknowledgement.");
    const historicalSecond = sequencedSubmitResult(2, "Historical second acknowledgement.");
    const resumedNext = sequencedSubmitResult(3, "Resumed call acknowledgement.");
    mockCallModeState({ submitResults: [resumedNext] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        callDispatches={[historicalFirst.dispatch, historicalSecond.dispatch]}
        callUtterances={[historicalFirst.utterance, historicalSecond.utterance]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "Resumed call acknowledgement.",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not mark an in-flight call ACK as already spoken when bootstrap refreshes first", async () => {
    const historicalFirst = sequencedSubmitResult(1, "Historical first acknowledgement.");
    const historicalSecond = sequencedSubmitResult(2, "Historical second acknowledgement.");
    const freshResult = sequencedSubmitResult(3, "Fresh acknowledgement.");
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...props}
        callDispatches={[historicalFirst.dispatch, historicalSecond.dispatch]}
        callUtterances={[historicalFirst.utterance, historicalSecond.utterance]}
      />);
    });

    mockCallModeState({ isSubmitting: true });
    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[historicalFirst.dispatch, historicalSecond.dispatch, freshResult.dispatch]}
        callUtterances={[historicalFirst.utterance, historicalSecond.utterance, freshResult.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    mockCallModeState({ submitResults: [freshResult] });
    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[historicalFirst.dispatch, historicalSecond.dispatch, freshResult.dispatch]}
        callUtterances={[historicalFirst.utterance, historicalSecond.utterance, freshResult.utterance]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "Fresh acknowledgement." });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not mark an async coordinator ACK as already spoken while submit is still pending", async () => {
    const pendingResult = sequencedSubmitResult(1, "收到，已进入调度队列。");
    pendingResult.dispatch.intent = "coordinator_pending";
    pendingResult.dispatch.status = "dispatching";
    pendingResult.dispatch.outcome = "dispatching";
    pendingResult.utterance.status = "dispatching";
    const finalResult = sequencedSubmitResult(1, "听到了，我在。");
    finalResult.dispatch.id = "dispatch-final-ack-1";
    finalResult.dispatch.intent = "ack_only";
    finalResult.dispatch.status = "acknowledged";
    finalResult.dispatch.outcome = "acknowledged";
    finalResult.dispatch.status_text = "Heard and acknowledged.";
    const props = baseCallConsoleProps();

    mockCallModeState({ isSubmitting: true, submitResults: [] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...props}
        callDispatches={[pendingResult.dispatch]}
        callUtterances={[pendingResult.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[pendingResult.dispatch, finalResult.dispatch]}
        callUtterances={[pendingResult.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    mockCallModeState({ isSubmitting: false, submitResults: [finalResult], lastResult: finalResult });
    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[pendingResult.dispatch, finalResult.dispatch]}
        callUtterances={[{ ...pendingResult.utterance, status: "acknowledged" }]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "听到了，我在。",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks newly inserted call ACK dispatches from backend refresh", async () => {
    const historicalAck = sequencedSubmitResult(1, "Historical acknowledgement.");
    const freshUtterance: CallUtterance = {
      ...historicalAck.utterance,
      id: "utterance-fresh-ack-2",
      sequence: 2,
      transcript: "直接念给我",
      created_at: "2026-05-24T00:00:03.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
    };
    const freshAck: CallDispatch = {
      ...historicalAck.dispatch,
      id: "dispatch-fresh-ack-2",
      utterance_id: freshUtterance.id,
      utterance_sequence: freshUtterance.sequence,
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "可以，我直接念给你。",
      status: "acknowledged",
      outcome: "acknowledged",
      status_text: "Acknowledged",
      created_at: "2026-05-24T00:00:05.000Z",
      updated_at: "2026-05-24T00:00:05.000Z",
    };
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...props}
        callDispatches={[historicalAck.dispatch]}
        callUtterances={[historicalAck.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[historicalAck.dispatch, freshAck]}
        callUtterances={[historicalAck.utterance, freshUtterance]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "可以，我直接念给你。",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks the final coordinator ACK when it replaces a pending dispatch for the same utterance", async () => {
    const pendingResult = sequencedSubmitResult(1, "收到，已进入调度队列。");
    pendingResult.dispatch.intent = "coordinator_pending";
    pendingResult.dispatch.status = "queued";
    pendingResult.dispatch.outcome = "queued";
    pendingResult.utterance.status = "queued";
    const finalAck: CallDispatch = {
      ...pendingResult.dispatch,
      id: "dispatch-final-ack-1",
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "听到了，我在。",
      status: "acknowledged",
      outcome: "acknowledged",
      status_text: "Heard and acknowledged.",
      created_at: "2026-05-24T00:00:03.000Z",
      updated_at: "2026-05-24T00:00:03.000Z",
    };
    const props = baseCallConsoleProps();

    mockCallModeState({ submitResults: [pendingResult] });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...props}
        callDispatches={[pendingResult.dispatch]}
        callUtterances={[pendingResult.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[pendingResult.dispatch, finalAck]}
        callUtterances={[{ ...pendingResult.utterance, status: "acknowledged" }]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "听到了，我在。",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps incomplete queued and superseded call dispatch receipts out of assistant speech", async () => {
    const baseAck = sequencedSubmitResult(1, "I will ask kunk to check it.");
    const supersededAck: CallDispatch = {
      ...baseAck.dispatch,
      id: "dispatch-superseded-ack",
      status: "superseded",
      ack_status: "resolved",
      ack_text: "I will ask kunk to check it.",
    };
    const queuedAck: CallDispatch = {
      ...baseAck.dispatch,
      id: "dispatch-queued-ack",
      status: "queued",
      ack_status: "understood",
      ack_text: "I will ask kunk to check it.",
      created_at: "2026-05-24T00:00:06.000Z",
      updated_at: "2026-05-24T00:00:06.000Z",
    };
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[supersededAck, queuedAck]}
        callUtterances={[baseAck.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks queued agent work handoffs once a work item is linked", async () => {
    const baseAck = sequencedSubmitResult(1, "我让坤坤看一下。");
    const queuedWorkAck: CallDispatch = {
      ...baseAck.dispatch,
      id: "dispatch-queued-work-ack",
      intent: "agent_work",
      status: "queued",
      ack_status: "understood",
      ack_text: "我让坤坤看一下。",
      outcome: "work_queued",
      work_item_id: "work-queued-1",
      created_at: "2026-05-24T00:00:06.000Z",
      updated_at: "2026-05-24T00:00:06.000Z",
    };
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        callDispatches={[queuedWorkAck]}
        callUtterances={[baseAck.utterance]}
      />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "我让坤坤看一下。" });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks queued cancel work acknowledgements from submit results", async () => {
    const cancelResult: CallUtteranceSubmitResult = {
      ...sequencedSubmitResult(1, "我先把这个任务取消掉。"),
      dispatch: {
        ...sequencedSubmitResult(1, "我先把这个任务取消掉。").dispatch,
        intent: "cancel_work",
        ack_status: "understood",
        status: "queued",
        outcome: "work_cancel_requested",
        status_text: "Cancellation requested.",
        work_item_id: "work-cancel-1",
      },
    };
    const props = baseCallConsoleProps();
    mockCallModeState({ submitResults: [cancelResult] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "我先把这个任务取消掉。",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("ignores legacy worker feedback dispatches that arrive through bootstrap refresh", async () => {
    const historicalAck = sequencedSubmitResult(1, "Historical acknowledgement.");
    const workerFeedback: CallDispatch = {
      ...historicalAck.dispatch,
      id: "dispatch-worker-feedback-2",
      utterance_sequence: 2,
      intent: "worker_feedback",
      ack_status: "heard",
      ack_text: "关于 美股涨势，Ada说：我查到了，美股最近上涨主要集中在科技和半导体，纳指表现更强。",
      speech_topic: "美股涨势",
      status: "acknowledged",
      outcome: "acknowledged",
      status_text: "Worker result",
      target_agent_id: adaAgent.id,
      work_item_id: "work-voice-1",
      created_at: "2026-05-24T00:00:05.000Z",
      updated_at: "2026-05-24T00:00:05.000Z",
    };
    const workerUtterance: CallUtterance = {
      ...historicalAck.utterance,
      id: "utterance-worker-feedback-2",
      sequence: 2,
      transcript: "查一下最近美股涨势",
      created_at: "2026-05-24T00:00:03.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
    };
    workerFeedback.utterance_id = workerUtterance.id;
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...props}
        agents={[adaAgent]}
        callDispatches={[historicalAck.dispatch]}
        callUtterances={[historicalAck.utterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.update(<CallConsole
        {...props}
        agents={[adaAgent]}
        callDispatches={[historicalAck.dispatch, workerFeedback]}
        callUtterances={[historicalAck.utterance, workerUtterance]}
      />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps assistant speech state out of the compact Voice controls", async () => {
    mockCallModeState({ submitResults: [submitResult] });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).not.toContain("Yielding to voice");
    expect(tree).not.toContain("Assistant");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps ignored diagnostics silent", async () => {
    const props = baseCallConsoleProps();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    const ignoredDiagnostic: CallUtteranceSubmitResult = {
      ...submitResult,
      utterance: {
        ...submitResult.utterance,
        id: "utterance-ignored-diagnostic",
        status: "ignored",
      },
      dispatch: {
        ...submitResult.dispatch,
        id: "dispatch-ignored-diagnostic",
        utterance_id: "utterance-ignored-diagnostic",
        ack_text: "这段没有检测到说话，我先忽略了。",
        status: "ignored",
        error: "emptyTranscript: no speech detected",
      },
      ack_text: "这段没有检测到说话，我先忽略了。",
    };
    mockCallModeState({ lastResult: ignoredDiagnostic });
    await act(async () => {
      renderer.update(<CallConsole {...props} />);
    });
    expect(speechSpeak).not.toHaveBeenCalled();

    expect(speechCancel).not.toHaveBeenCalled();
    expect(speechSpeak).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps wake-word-required ignored turns silent", async () => {
    const props = baseCallConsoleProps();
    const ignoredWakeRequired: CallUtteranceSubmitResult = {
      ...submitResult,
      utterance: {
        ...submitResult.utterance,
        id: "utterance-wake-required",
        transcript: "他妈，他这个到底怎么回事？这个代码怎么气呀？",
        transcription_error: "wake word required: 小帅,小美,Lantor",
        status: "ignored",
      },
      dispatch: {
        ...submitResult.dispatch,
        id: "dispatch-wake-required",
        utterance_id: "utterance-wake-required",
        ack_text: "等待唤醒词。",
        status: "ignored",
        outcome: "ignored",
        error: "wake word required: 小帅,小美,Lantor",
      },
      ack_text: "等待唤醒词。",
    };

    let renderer!: ReactTestRenderer;
    mockCallModeState({ lastResult: ignoredWakeRequired });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).not.toContain("等待唤醒词。");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not let silent diagnostics block later call ACK speech", async () => {
    const silentDiagnostic: CallUtteranceSubmitResult = {
      ...sequencedSubmitResult(1, "这段没有检测到说话，我先忽略了。"),
      utterance: {
        ...sequencedSubmitResult(1, "这段没有检测到说话，我先忽略了。").utterance,
        status: "ignored",
        transcription_error: "emptyTranscript: no speech detected",
      },
      dispatch: {
        ...sequencedSubmitResult(1, "这段没有检测到说话，我先忽略了。").dispatch,
        status: "ignored",
        error: "emptyTranscript: no speech detected",
      },
    };
    const nextResult = sequencedSubmitResult(2, "第二句应该正常播报。");
    const props = baseCallConsoleProps();

    let renderer!: ReactTestRenderer;
    mockCallModeState({ submitResults: [silentDiagnostic, nextResult] });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({
      text: "第二句应该正常播报。",
      lang: "zh-CN",
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps routine transcription failures out of assistant speech", async () => {
    const failedDiagnostic: CallUtteranceSubmitResult = {
      ...submitResult,
      utterance: {
        ...submitResult.utterance,
        id: "utterance-failed-diagnostic",
        transcript: "",
        transcription_error: "emptyTranscript: No speech detected in 14s audio",
        status: "failed",
      },
      dispatch: {
        ...submitResult.dispatch,
        id: "dispatch-failed-diagnostic",
        utterance_id: "utterance-failed-diagnostic",
        ack_text: "Voice transcription failed: No speech detected in 14s audio.",
        status: "failed",
        error: "emptyTranscript: No speech detected in 14s audio",
      },
      ack_text: "Voice transcription failed: No speech detected in 14s audio.",
    };
    const props = baseCallConsoleProps();
    let renderer!: ReactTestRenderer;

    mockCallModeState({ lastResult: failedDiagnostic });
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });

    expect(speechSpeak).not.toHaveBeenCalled();
    expect(speechCancel).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("renders Voice with the channel message list and composer controls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-05-24T00:01:10.000Z").getTime());
    mockCallModeState({ isSubmitting: true });
    mockRecorderState({ pendingSubmitCount: 1, statusMessage: "Listening; sending captured utterance..." });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...baseCallConsoleProps()} />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("message-list");
    expect(tree).toContain("No voice messages yet");
    expect(tree).toContain("Message Voice");
    expect(tree).toContain("composer call-mode-typed-utterance");
    expect(tree).toContain("Listening; sending captured utterance...");
    expect(findButtonByLabel(renderer, "Mute microphone").props.disabled).toBe(false);
    expect(findButtonByLabel(renderer, "Submit typed Call Mode speech").props.disabled).toBe(true);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps previous Voice messages visible after a new Call session starts", async () => {
    const oldUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-old-session",
      session_id: endedSession.id,
      transcript: "old call request should remain visible",
      created_at: "2026-05-23T23:58:10.000Z",
      updated_at: "2026-05-23T23:58:11.000Z",
    };
    const oldDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-old-session",
      session_id: endedSession.id,
      utterance_id: oldUtterance.id,
      ack_text: "Old request acknowledged.",
      created_at: "2026-05-23T23:58:12.000Z",
      updated_at: "2026-05-23T23:58:12.000Z",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={oldUtterance.id}
        callSessions={[activeSession, endedSession]}
        callUtterances={[oldUtterance]}
        callDispatches={[oldDispatch]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("old call request should remain visible");
    expect(tree).toContain("Old request acknowledged.");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows fixed-channel Voice Console sessions in the call surface", async () => {
    const fixedChannelSession: CallSession = {
      ...activeSession,
      id: "fixed-channel-call-session",
      channel_id: "voice-console-channel",
      title: "Voice Console",
    };
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "fixed-channel-utterance",
      session_id: fixedChannelSession.id,
      transcript: "fixed channel voice request",
      source_message_id: "fixed-channel-message",
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "fixed-channel-dispatch",
      session_id: fixedChannelSession.id,
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      ack_text: "Fixed channel request acknowledged.",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={utterance.id}
        callSessions={[fixedChannelSession]}
        callUtterances={[utterance]}
        callDispatches={[dispatch]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("fixed channel voice request");
    expect(tree).toContain("Fixed channel request acknowledged.");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps long no-speech diagnostics out of the call thread", async () => {
    const failedUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-long-no-speech",
      transcript: "",
      status: "ignored",
      transcription_provider: "",
      transcription_error: "providerFailed: No speech detected",
      audio_duration_ms: 32_000,
    };
    const failedDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-long-no-speech",
      utterance_id: failedUtterance.id,
      ack_status: "heard",
      ack_text: "这段没有检测到说话，我先忽略了。",
      status: "ignored",
      outcome: "ignored",
      error: "providerFailed: No speech detected",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        callUtterances={[failedUtterance]}
        callDispatches={[failedDispatch]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).not.toContain("No speech detected");
    expect(tree).not.toContain("32s audio");
    expect(tree).not.toContain("providerFailed: No speech detected");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("shows the exact pending confirmation request, proposed target, and real controls", async () => {
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-confirm-1",
      sequence: 4,
      transcript: "maybe send this over there",
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-confirm-1",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      ack_status: "needs_confirmation",
      ack_text: "I think this is for Ada, but please confirm before I assign it.",
      confidence: "low",
      target_agent_id: adaAgent.id,
      status: "needs_user",
      outcome: "needs_user",
      status_text: "Waiting for confirmation",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        agents={[adaAgent]}
        callDispatches={[dispatch]}
        callUtterances={[utterance]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("Pending call confirmation");
    expect(tree).toContain("Confirm before assigning");
    expect(tree).toContain("maybe send this over there");
    expect(tree).toContain("@ada");
    expect(tree).toContain("Confirm");
    expect(tree).toContain("Reject");
    expect(tree).toContain("Correct");
    expect(findButtonByLabel(renderer, "Confirm call request number 4").props.disabled).toBe(false);
    expect(findButtonByLabel(renderer, "Reject call request number 4").props.disabled).toBe(false);
    expect(findInputByLabel(renderer, "Correct call request number 4").props.disabled).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("routes pending confirmation buttons through call-control resolution", async () => {
    const resolveConfirmation = vi.fn(async () => submitResult);
    mockCallModeState({ resolveConfirmation });
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-confirm-1",
      sequence: 4,
      transcript: "maybe send this over there",
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-confirm-1",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      ack_status: "needs_confirmation",
      ack_text: "I think this is for Ada, but please confirm before I assign it.",
      confidence: "low",
      target_agent_id: adaAgent.id,
      status: "needs_user",
      outcome: "needs_user",
      status_text: "Waiting for confirmation",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        agents={[adaAgent]}
        callDispatches={[dispatch]}
        callUtterances={[utterance]}
      />);
    });

    await act(async () => {
      await findButtonByLabel(renderer, "Confirm call request number 4").props.onClick();
    });
    await act(async () => {
      await findButtonByLabel(renderer, "Reject call request number 4").props.onClick();
    });
    await act(async () => {
      findInputByLabel(renderer, "Correct call request number 4").props.onChange({
        currentTarget: { value: "@bob" },
      });
    });
    await act(async () => {
      await renderer.root.findByProps({ className: "call-mode-confirmation-correct" }).props.onSubmit({
        preventDefault: vi.fn(),
      });
      await Promise.resolve();
    });

    expect(resolveConfirmation).toHaveBeenNthCalledWith(1, "yes");
    expect(resolveConfirmation).toHaveBeenNthCalledWith(2, "no");
    expect(resolveConfirmation).toHaveBeenNthCalledWith(3, "@bob");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("hides a stale pending confirmation after a newer non-ignored call turn", async () => {
    const pendingUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-confirm-1",
      sequence: 4,
      transcript: "maybe send this over there",
    };
    const pendingDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-confirm-1",
      utterance_id: pendingUtterance.id,
      utterance_sequence: pendingUtterance.sequence,
      ack_status: "needs_confirmation",
      ack_text: "I think this is for Ada, but please confirm before I assign it.",
      confidence: "low",
      target_agent_id: adaAgent.id,
      status: "needs_user",
      outcome: "needs_user",
      status_text: "Waiting for confirmation",
    };
    const unrelatedUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-unrelated-1",
      sequence: 5,
      transcript: "thanks for the update",
    };
    const unrelatedDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-unrelated-1",
      utterance_id: unrelatedUtterance.id,
      utterance_sequence: unrelatedUtterance.sequence,
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "Thanks noted.",
      status: "acknowledged",
      outcome: "acknowledged",
      status_text: "Acknowledged",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={unrelatedUtterance.id}
        agents={[adaAgent]}
        callDispatches={[pendingDispatch, unrelatedDispatch]}
        callUtterances={[pendingUtterance, unrelatedUtterance]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).not.toContain("Pending call confirmation");
    expect(tree).not.toContain("Confirm before assigning");
    expect(tree).toContain("Thanks noted.");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("keeps a pending confirmation visible after a newer ignored call diagnostic", async () => {
    const pendingUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-confirm-1",
      sequence: 4,
      transcript: "maybe send this over there",
    };
    const pendingDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-confirm-1",
      utterance_id: pendingUtterance.id,
      utterance_sequence: pendingUtterance.sequence,
      ack_status: "needs_confirmation",
      ack_text: "I think this is for Ada, but please confirm before I assign it.",
      confidence: "low",
      target_agent_id: adaAgent.id,
      status: "needs_user",
      outcome: "needs_user",
      status_text: "Waiting for confirmation",
    };
    const ignoredUtterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-ignored-1",
      sequence: 5,
      transcript: "",
      transcription_error: "emptyTranscript: no speech detected",
      status: "ignored",
    };
    const ignoredDispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-ignored-1",
      utterance_id: ignoredUtterance.id,
      utterance_sequence: ignoredUtterance.sequence,
      intent: "ack_only",
      ack_status: "heard",
      ack_text: "这段没有检测到说话，我先忽略了。",
      status: "ignored",
      outcome: "ignored",
      status_text: "Ignored",
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        agents={[adaAgent]}
        callDispatches={[pendingDispatch, ignoredDispatch]}
        callUtterances={[pendingUtterance, ignoredUtterance]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("Pending call confirmation");
    expect(tree).toContain("maybe send this over there");
    expect(tree).toContain("@ada");

    await act(async () => {
      renderer.unmount();
    });
  });

  it("renders live call work as normal channel-style agent messages", async () => {
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-work-1",
      sequence: 3,
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-work-1",
      intent: "agent_work",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      target_agent_id: "agent-1",
      work_item_id: "work-1",
      status: "queued",
      outcome: "work_queued",
    };
    const workItem: AgentWorkItem = {
      id: "work-1",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: channel.id,
      channel_name: channel.name,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: activeSession.id,
      call_utterance_id: utterance.id,
      call_dispatch_id: dispatch.id,
      source_kind: "call_mode",
      title: "Prepare the note",
      context: "Call Mode request",
      status: "queued",
      run_id: null,
      created_at: "2026-05-24T00:00:04.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
      completed_at: null,
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole
        {...baseCallConsoleProps()}
        activeCallThreadId={utterance.id}
        callDispatches={[dispatch]}
        callUtterances={[utterance]}
        agentWorkItems={[workItem]}
      />);
    });

    const tree = JSON.stringify(renderer.toJSON());
    expect(tree).toContain("thread-root");
    expect(tree).toContain("reply-list");
    expect(tree).toContain("Prepare the note");
    expect(tree).toContain("call-mode-work-board");
    expect(() => findButtonByLabel(renderer, "Cancel call request number 3")).not.toThrow();

    await act(async () => {
      renderer.unmount();
    });
  });

  it("speaks call worker replies directly", async () => {
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-work-reply-1",
      sequence: 3,
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-work-reply-1",
      intent: "agent_work",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      target_agent_id: "agent-1",
      work_item_id: "work-1",
      status: "acknowledged",
      outcome: "work_queued",
    };
    const workItem: AgentWorkItem = {
      id: "work-1",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: channel.id,
      channel_name: channel.name,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: activeSession.id,
      call_utterance_id: utterance.id,
      call_dispatch_id: dispatch.id,
      source_kind: "call_mode",
      title: "Prepare the note",
      context: "Call Mode request",
      status: "done",
      run_id: null,
      created_at: "2026-05-24T00:00:04.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
      completed_at: "2026-05-24T00:00:05.000Z",
    };
    const workerReply = workerReplyMessage(
      "worker-reply-1",
      workItem,
      "关于 最近动态，Ada说，最近动态已经整理好。",
      "2026-05-24T00:00:05.000Z",
    );
    const props = {
      ...baseCallConsoleProps(),
      agents: [adaAgent],
      agentWorkItems: [workItem],
      callDispatches: [dispatch],
      callUtterances: [utterance],
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} />);
    });
    await act(async () => {
      renderer.update(<CallConsole {...props} messages={[workerReply]} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: "关于 最近动态，Ada说，最近动态已经整理好。" });

    expect(speechSpeak).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("does not repeat a worker result when the persisted message replaces result_body fallback", async () => {
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-work-reply-fallback-1",
      sequence: 3,
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-work-reply-fallback-1",
      intent: "agent_work",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      target_agent_id: "agent-1",
      work_item_id: "work-fallback-1",
      status: "acknowledged",
      outcome: "work_queued",
    };
    const baseWorkItem: AgentWorkItem = {
      id: "work-fallback-1",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: channel.id,
      channel_name: channel.name,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: activeSession.id,
      call_utterance_id: utterance.id,
      call_dispatch_id: dispatch.id,
      source_kind: "call_mode",
      title: "Prepare the note",
      context: "Call Mode request",
      status: "running",
      run_id: null,
      created_at: "2026-05-24T00:00:04.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
      completed_at: null,
    };
    const resultBody = "关于 最近动态，Ada说，最近动态已经整理好。";
    const completedWorkItem: AgentWorkItem = {
      ...baseWorkItem,
      status: "done",
      result_body: resultBody,
      updated_at: "2026-05-24T00:00:05.000Z",
      completed_at: "2026-05-24T00:00:05.000Z",
    };
    const workerReply = workerReplyMessage(
      "worker-reply-fallback-1",
      completedWorkItem,
      `${resultBody}（持久消息版本）`,
      "2026-05-24T00:00:06.000Z",
    );
    const props = {
      ...baseCallConsoleProps(),
      agents: [adaAgent],
      callDispatches: [dispatch],
      callUtterances: [utterance],
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} agentWorkItems={[baseWorkItem]} />);
    });
    await act(async () => {
      renderer.update(<CallConsole {...props} agentWorkItems={[completedWorkItem]} />);
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);
    expect(speechSpeak.mock.calls[0][0]).toMatchObject({ text: resultBody });

    await act(async () => {
      renderer.update(
        <CallConsole
          {...props}
          agentWorkItems={[completedWorkItem]}
          messages={[workerReply]}
        />,
      );
    });

    expect(speechSpeak).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it("cancels browser speech before playing Edge TTS audio", async () => {
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => JSON.stringify({
          tts: { provider: "edge", voice: "zh-CN-XiaoxiaoNeural", rate: 1 },
        })),
        setItem: vi.fn(),
      },
    });
    const originalAudio = globalThis.Audio;
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const audioPlay = vi.fn(async () => undefined);
    const audioPause = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:edge-call-tts"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src: string;
        volume = 1;

        constructor(src: string) {
          this.src = src;
        }

        play = audioPlay;
        pause = audioPause;
      },
    });
    apiInvokeMock.mockResolvedValueOnce({
      provider: "edge",
      mime_type: "audio/mpeg",
      bytes: [1, 2, 3],
    });
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-edge-tts-1",
      sequence: 3,
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-edge-tts-1",
      intent: "agent_work",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      target_agent_id: "agent-1",
      work_item_id: "work-edge-tts-1",
      status: "acknowledged",
      outcome: "work_queued",
    };
    const baseWorkItem: AgentWorkItem = {
      id: "work-edge-tts-1",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: channel.id,
      channel_name: channel.name,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: activeSession.id,
      call_utterance_id: utterance.id,
      call_dispatch_id: dispatch.id,
      source_kind: "call_mode",
      title: "Prepare the note",
      context: "Call Mode request",
      status: "running",
      run_id: null,
      created_at: "2026-05-24T00:00:04.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
      completed_at: null,
    };
    const completedWorkItem: AgentWorkItem = {
      ...baseWorkItem,
      status: "done",
      result_body: "Edge TTS response.",
      updated_at: "2026-05-24T00:00:05.000Z",
      completed_at: "2026-05-24T00:00:05.000Z",
    };
    const props = {
      ...baseCallConsoleProps(),
      agents: [adaAgent],
      callDispatches: [dispatch],
      callUtterances: [utterance],
    };

    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(<CallConsole {...props} agentWorkItems={[baseWorkItem]} />);
      });
      await act(async () => {
        renderer.update(<CallConsole {...props} agentWorkItems={[completedWorkItem]} />);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(apiInvokeMock).toHaveBeenCalledWith("synthesize_tts_audio", expect.objectContaining({
        provider: "edge",
        voice: "zh-CN-XiaoxiaoNeural",
      }));
      expect(audioPlay).toHaveBeenCalledTimes(1);
      expect(speechCancel).toHaveBeenCalledTimes(1);
      expect(speechSpeak).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      if (originalAudio === undefined) delete (globalThis as Partial<typeof globalThis>).Audio;
      else Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
      if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
      else delete (URL as Partial<typeof URL>).createObjectURL;
      if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
      else delete (URL as Partial<typeof URL>).revokeObjectURL;
    }
  });

  it("speaks full Voice worker result bodies without clipping", async () => {
    vi.useFakeTimers();
    (globalThis.window as typeof window).setTimeout = globalThis.setTimeout;
    (globalThis.window as typeof window).clearTimeout = globalThis.clearTimeout;
    const utterance: CallUtterance = {
      ...submitResult.utterance,
      id: "utterance-work-result-1",
      sequence: 3,
    };
    const dispatch: CallDispatch = {
      ...submitResult.dispatch,
      id: "dispatch-work-result-1",
      intent: "agent_work",
      utterance_id: utterance.id,
      utterance_sequence: utterance.sequence,
      target_agent_id: "agent-1",
      work_item_id: "work-result-1",
      status: "acknowledged",
      outcome: "work_queued",
    };
    const baseWorkItem: AgentWorkItem = {
      id: "work-result-1",
      agent_id: "agent-1",
      agent_handle: "ada",
      channel_id: null,
      channel_name: null,
      thread_root_id: null,
      source_message_id: null,
      inbox_item_id: null,
      task_id: null,
      task_number: null,
      call_session_id: activeSession.id,
      call_utterance_id: utterance.id,
      call_dispatch_id: dispatch.id,
      source_kind: "call_mode",
      title: "Prepare the long note",
      context: "Call Mode request",
      status: "running",
      run_id: "run-result-1",
      created_at: "2026-05-24T00:00:04.000Z",
      updated_at: "2026-05-24T00:00:04.000Z",
      completed_at: null,
    };
    const resultBody = `关于 长内容，Ada说，${"测试内容，".repeat(40)}结束。`;
    const props = {
      ...baseCallConsoleProps(),
      agents: [adaAgent],
      callDispatches: [dispatch],
      callUtterances: [utterance],
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<CallConsole {...props} agentWorkItems={[baseWorkItem]} />);
    });
    await act(async () => {
      renderer.update(
        <CallConsole
          {...props}
          agentWorkItems={[{
            ...baseWorkItem,
            status: "done",
            result_body: resultBody,
            updated_at: "2026-05-24T00:00:06.000Z",
            completed_at: "2026-05-24T00:00:06.000Z",
          }]}
        />,
      );
    });

    for (let index = 0; index < speechSpeak.mock.calls.length; index += 1) {
      const utterance = speechSpeak.mock.calls[index][0] as { onend?: () => void };
      await act(async () => {
        utterance.onend?.();
        vi.runOnlyPendingTimers();
      });
    }

    const spokenText = speechSpeak.mock.calls.map((call) => call[0].text).join("");
    expect(spokenText).toBe(resultBody);
    expect(spokenText).not.toContain("...");

    await act(async () => {
      renderer.unmount();
    });
  });
});
