import type { Message } from "./types";
import { formatTime } from "./ui-utils";

function attachmentLines(message: Message) {
  return message.attachments.map((attachment) => (
    `- Attachment: ${attachment.original_name} (${attachment.mime_type}, ${attachment.size_bytes} bytes)`
  ));
}

function artifactLines(message: Message) {
  return message.artifacts.map((artifact) => (
    `- Artifact: ${artifact.title || artifact.kind} (${artifact.kind})`
  ));
}

export function messageShareLink(message: Message, baseUrl?: string | null) {
  const base = (baseUrl && baseUrl.trim()) || window.location.origin;
  const url = new URL(base, window.location.href);
  url.hash = `/message/${message.id}`;
  return url.toString();
}

export function messageToMarkdown(message: Message, surfaceLabel: string) {
  const lines = [
    `### ${message.sender_name} - ${formatTime(message.created_at)}`,
    "",
    `Surface: ${surfaceLabel}`,
    "",
    message.body.trim() || "_Empty message_",
  ];
  const attachments = attachmentLines(message);
  const artifacts = artifactLines(message);
  if (attachments.length > 0 || artifacts.length > 0) {
    lines.push("", "Resources:", ...attachments, ...artifacts);
  }
  return lines.join("\n");
}
