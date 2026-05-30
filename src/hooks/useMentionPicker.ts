import { useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import {
  filterMentionChannels,
  filterMentionAgents,
  getChannelMentionState,
  getMentionState,
  insertAgentDisplayMention,
  insertChannelMention,
  type TokenMentionState,
} from "../mentions";
import { Agent, Channel } from "../types";

type UseMentionPickerArgs = {
  agents: Agent[];
  channels?: Channel[];
  value: string;
  setValue: (value: string) => void;
  onAgentMentionSelected?: (agent: Agent) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export type MentionPickerCandidate =
  | { kind: "agent"; id: string; agent: Agent }
  | { kind: "channel"; id: string; channel: Channel };

export function useMentionPicker({ agents, channels = [], value, setValue, onAgentMentionSelected, textareaRef }: UseMentionPickerArgs) {
  const [mentionState, setMentionState] = useState<TokenMentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionCandidates = useMemo<MentionPickerCandidate[]>(() => {
    if (!mentionState) return [];
    if (mentionState.kind === "channel") {
      return filterMentionChannels(channels, mentionState.query).map((channel) => ({
        kind: "channel",
        id: channel.id,
        channel,
      }));
    }
    return filterMentionAgents(agents, mentionState.query).map((agent) => ({
      kind: "agent",
      id: agent.id,
      agent,
    }));
  }, [agents, channels, mentionState]);

  function focusComposer(cursor?: number) {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (cursor !== undefined) {
        textareaRef.current?.setSelectionRange(cursor, cursor);
      }
    });
  }

  function refreshMentionState(text: string, cursor: number) {
    const agentState = getMentionState(text, cursor);
    const channelState = getChannelMentionState(text, cursor);
    setMentionState(
      agentState
        ? { ...agentState, kind: "agent" }
        : channelState
          ? { ...channelState, kind: "channel" }
          : null,
    );
    setMentionIndex(0);
  }

  function closeMentionPicker() {
    setMentionState(null);
  }

  function chooseMention(candidate: MentionPickerCandidate) {
    if (!mentionState) return;
    const { nextText, nextCursor } = candidate.kind === "agent"
      ? insertAgentDisplayMention(value, mentionState, candidate.agent)
      : insertChannelMention(value, mentionState, candidate.channel.name);
    setValue(nextText);
    if (candidate.kind === "agent") onAgentMentionSelected?.(candidate.agent);
    closeMentionPicker();
    focusComposer(nextCursor);
  }

  function handleMentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionState || mentionCandidates.length === 0) return false;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((current) => (current + 1) % mentionCandidates.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      chooseMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionPicker();
      return true;
    }

    return false;
  }

  return {
    mentionState,
    mentionIndex,
    mentionCandidates,
    refreshMentionState,
    chooseMention,
    handleMentionKeyDown,
    closeMentionPicker,
    focusComposer,
  };
}
