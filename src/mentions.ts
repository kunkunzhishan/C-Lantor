import { Agent, Channel } from "./types";

export type MentionState = {
  query: string;
  start: number;
  end: number;
};

export type MentionKind = "agent" | "channel";

export type TokenMentionState = MentionState & {
  kind: MentionKind;
};

export type AgentMentionBinding = {
  label: string;
  handle: string;
};

function isMentionBoundary(text: string, markerIndex: number) {
  if (markerIndex === 0) return true;
  const previous = text[markerIndex - 1];
  return !/[A-Za-z0-9_-]/.test(previous);
}

function getTokenMentionState(text: string, cursor: number, marker: "@" | "#"): MentionState | null {
  const beforeCursor = text.slice(0, cursor);
  const otherMarker = marker === "@" ? "#" : "@";
  const match = beforeCursor.match(new RegExp(`${marker}([^\\s${otherMarker}]*)$`, "u"));
  if (!match || match.index === undefined) return null;
  if (!isMentionBoundary(beforeCursor, match.index)) return null;
  const query = match[1] ?? "";
  return {
    query,
    start: match.index,
    end: cursor,
  };
}

export function getMentionState(text: string, cursor: number): MentionState | null {
  return getTokenMentionState(text, cursor, "@");
}

export function getChannelMentionState(text: string, cursor: number): MentionState | null {
  return getTokenMentionState(text, cursor, "#");
}

export function insertAgentMention(text: string, state: MentionState, handle: string) {
  const insertion = `@${handle} `;
  const nextText = `${text.slice(0, state.start)}${insertion}${text.slice(state.end)}`;
  const nextCursor = state.start + insertion.length;
  return { nextText, nextCursor };
}

export function insertAgentDisplayMention(text: string, state: MentionState, agent: Agent) {
  const insertion = `@${agentMentionLabel(agent)} `;
  const nextText = `${text.slice(0, state.start)}${insertion}${text.slice(state.end)}`;
  const nextCursor = state.start + insertion.length;
  return { nextText, nextCursor };
}

export function insertChannelMention(text: string, state: MentionState, name: string) {
  const insertion = `#${name} `;
  const nextText = `${text.slice(0, state.start)}${insertion}${text.slice(state.end)}`;
  const nextCursor = state.start + insertion.length;
  return { nextText, nextCursor };
}

export function filterMentionAgents(agents: Agent[], query: string) {
  const lowered = query.toLowerCase();
  return agents
    .filter((agent) => {
      const haystack =
        `${agent.handle} ${agent.display_name} ${agent.role} ${agent.description} ${agent.runtime} ${agent.model}`.toLowerCase();
      return haystack.includes(lowered);
    })
    .slice(0, 6);
}

export function filterMentionChannels(channels: Channel[], query: string) {
  const lowered = query.toLowerCase();
  return channels
    .filter((channel) => {
      if (channel.kind === "dm") return false;
      const haystack = `${channel.name} ${channel.description}`.toLowerCase();
      return haystack.includes(lowered);
    })
    .sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftStarts = leftName.startsWith(lowered);
      const rightStarts = rightName.startsWith(lowered);
      if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 6);
}

export function mentionedAgentsForBody(body: string, agents: Agent[]) {
  return agents.filter((agent) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegExp(agent.handle)}(?=$|[^A-Za-z0-9_-])`, "u");
    return pattern.test(body);
  });
}

export function agentMentionBinding(agent: Agent): AgentMentionBinding {
  return { label: agentMentionLabel(agent), handle: agent.handle };
}

export function serializeAgentDisplayMentions(body: string, agents: Agent[], bindings: AgentMentionBinding[] = []) {
  let serialized = body;
  for (const binding of bindings) {
    const label = binding.label.trim();
    const handle = binding.handle.trim();
    if (!label || !handle) continue;
    serialized = serialized.replace(
      new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegExp(label)}(?=$|[^A-Za-z0-9_-])`, "u"),
      `$1@${handle}`,
    );
  }

  const labels = new Map<string, Agent[]>();
  for (const agent of agents) {
    const label = agentMentionLabel(agent);
    const key = label.toLowerCase();
    labels.set(key, [...(labels.get(key) ?? []), agent]);
  }
  if (!Array.from(labels.values()).some((matches) => matches.length === 1)) return serialized;

  return serialized.replace(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+)/gu, (match, prefix: string, label: string) => {
    const agent = labels.get(label.toLowerCase());
    if (!agent || agent.length !== 1) return match;
    return `${prefix}@${agent[0].handle}`;
  });
}

export function agentMentionLabel(agent: Agent) {
  return (agent.display_name || agent.handle).trim() || agent.handle;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
