import type { ReactNode } from "react";
import type { Artifact } from "../types";
import { MessageArtifacts } from "./MessageArtifacts";

export const LONG_MESSAGE_FALLBACK_LINES = 24;
export const LONG_MESSAGE_FALLBACK_CHARS = 1_800;

export function isLongMessageFallback(body: string) {
  const text = body.trim();
  return Boolean(text)
    && (text.split("\n").length > LONG_MESSAGE_FALLBACK_LINES
      || text.length > LONG_MESSAGE_FALLBACK_CHARS);
}

function closeUnbalancedCodeFence(body: string) {
  const fenceMatches = body.match(/(^|\n)```/g);
  if (!fenceMatches || fenceMatches.length % 2 === 0) return body;
  return `${body.replace(/\s+$/, "")}\n\`\`\``;
}

export function longMessageFallbackPreview(body: string) {
  const text = body.trim();
  const linePreview = text.split("\n").slice(0, LONG_MESSAGE_FALLBACK_LINES).join("\n");
  const preview = linePreview.length > LONG_MESSAGE_FALLBACK_CHARS
    ? linePreview.slice(0, LONG_MESSAGE_FALLBACK_CHARS).replace(/\s+\S*$/, "")
    : linePreview;
  return closeUnbalancedCodeFence(preview);
}

function truncateText(value: string, limit: number) {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function longMessageFallbackTitle(body: string) {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "Long response";
  const title = firstLine
    .replace(/^[#>*\-\s]+/, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  return truncateText(title || "Long response", 90);
}

export function longMessageFallbackSummary(body: string) {
  const lines = body.split("\n");
  const firstNonempty = lines.findIndex((line) => line.trim());
  const paragraphs: string[] = [];
  let paragraph: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const skip = index === firstNonempty
      || trimmed.startsWith("```")
      || (trimmed.startsWith("|") && trimmed.endsWith("|"));
    if (!trimmed || skip) {
      if (paragraph.length > 0) {
        paragraphs.push(paragraph.join(" "));
        paragraph = [];
      }
      if (paragraphs.length >= 4) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  if (paragraphs.length < 4 && paragraph.length > 0) {
    paragraphs.push(paragraph.join(" "));
  }
  return truncateText(paragraphs.slice(0, 4).join("\n\n").trim(), 420);
}

function longMessageCodeBlockCount(body: string) {
  let insideCodeBlock = false;
  let count = 0;
  for (const line of body.split("\n")) {
    if (!line.trimStart().startsWith("```")) continue;
    if (!insideCodeBlock) count += 1;
    insideCodeBlock = !insideCodeBlock;
  }
  return count;
}

export function longMessageFallbackArtifact(
  body: string,
  messageId = "historical-long-message",
  channelId = "",
  threadRootId: string | null = null,
  creatorAgentId: string | null = null,
  createdAt = "",
  updatedAt = "",
): Artifact {
  return {
    id: `long-message-fallback:${messageId}`,
    message_id: messageId,
    channel_id: channelId,
    thread_root_id: threadRootId,
    creator_agent_id: creatorAgentId,
    creator_agent_handle: null,
    kind: "markdown",
    title: longMessageFallbackTitle(body),
    summary: longMessageFallbackSummary(body),
    content: body,
    metadata: {
      source: "long_message_fallback",
      preview_kind: "extractive",
      line_count: body.split("\n").length,
      char_count: Array.from(body).length,
      code_block_count: longMessageCodeBlockCount(body),
    },
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

type LongMessageFallbackProps = {
  body: string;
  expanded: boolean;
  onToggle: () => void;
  renderBody: (body: string) => ReactNode;
  messageId?: string;
  channelId?: string;
  threadRootId?: string | null;
  creatorAgentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  onOpenArtifact?: (artifact: Artifact) => void;
};

export function LongMessageFallback({
  body,
  renderBody,
  messageId,
  channelId,
  threadRootId,
  creatorAgentId,
  createdAt,
  updatedAt,
  onOpenArtifact,
}: LongMessageFallbackProps) {
  const isLong = isLongMessageFallback(body);
  if (!isLong) return <>{renderBody(body)}</>;

  return (
    <MessageArtifacts
      artifacts={[longMessageFallbackArtifact(
        body,
        messageId,
        channelId,
        threadRootId,
        creatorAgentId,
        createdAt,
        updatedAt,
      )]}
      onOpenArtifact={onOpenArtifact}
    />
  );
}
