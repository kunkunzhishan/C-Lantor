import {
  Children,
  memo,
  ReactNode,
  isValidElement,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppWindow } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalUrl, toolBrowserTargetFromHref } from "../apiClient";
import { copyText } from "../clipboard";
import { dispatchToolBrowserToggle } from "../toolBrowserEvents";

type MessageMarkdownProps = {
  body: string;
  agentMentionLabels?: Record<string, string>;
  onLocalAgentLink?: (handle: string) => void;
  onLocalLink?: (target: LocalEntityLinkTarget) => void;
};

export type LocalEntityLinkTarget =
  | { type: "agent"; handle: string }
  | { type: "channel"; channelRef: string; threadRef: string | null }
  | { type: "message"; messageRef: string }
  | { type: "task"; taskNumber: number };

const INLINE_CODE_SPLIT = /(`[^`\n]*(?:`|$))/g;
const FENCE_SPLIT = /(```[\s\S]*?(?:```|$))/g;
const LOCAL_ENTITY_PATH_PREFIX = "/lantor/";
const LOCAL_ENTITY_HASH_PREFIX = "#/";
const LOCAL_ENTITY_PATH_PATTERN = /^\/lantor\/(agent|channel|message|task)\/(.+)$/;
const LOCAL_LINK_PREFIX = /(^|[^A-Za-z0-9_/-])/;

function encodeLocalPath(value: string) {
  return encodeURIComponent(value.replace(/^[@#]/, ""));
}

function linkifyPlainText(value: string) {
  return value
    .replace(
      new RegExp(`${LOCAL_LINK_PREFIX.source}#([^\\s#0-9:/[\\](){},.;!?，。！？；：、][^\\s#:/[\\](){},.;!?，。！？；：、]*)(?::([A-Za-z0-9][A-Za-z0-9_-]{3,}))?(?=$|[\\s,.;!?)}\\]，。！？；：、])`, "g"),
      (_match, prefix, channel, threadRef) => (
        `${prefix}[#${channel}${threadRef ? `:${threadRef}` : ""}](${LOCAL_ENTITY_HASH_PREFIX}channel/${encodeLocalPath(channel)}${threadRef ? `/thread/${encodeLocalPath(threadRef)}` : ""})`
      ),
    )
    .replace(new RegExp(`${LOCAL_LINK_PREFIX.source}@([A-Za-z][A-Za-z0-9_-]{1,31})(?=$|[\\s.,;:!?)\\]}，。！？；：、])`, "g"), (_match, prefix, handle) => (
      `${prefix}[@${handle}](${LOCAL_ENTITY_HASH_PREFIX}agent/${encodeLocalPath(handle)})`
    ))
    .replace(/(^|[\s([{])task #([0-9]+)(?=$|[\s.,;:!?)\]}])/gi, (_match, prefix, taskNumber) => (
      `${prefix}[task #${taskNumber}](${LOCAL_ENTITY_HASH_PREFIX}task/${taskNumber})`
    ))
    .replace(/(^|[\s([{])msg=([A-Za-z0-9_-]{4,})(?=$|[\s,.;!?)}\]，。！？；：、])/g, (_match, prefix, messageRef) => (
      `${prefix}[msg=${messageRef}](${LOCAL_ENTITY_HASH_PREFIX}message/${encodeLocalPath(messageRef)})`
    ))
    .replace(/(^|[\s([{])lantor:\/\/message\/([A-Za-z0-9_-]{4,})(?=$|[\s,.;!?)}\]，。！？；：、])/gi, (_match, prefix, messageRef) => (
      `${prefix}[lantor://message/${messageRef}](${LOCAL_ENTITY_HASH_PREFIX}message/${encodeLocalPath(messageRef)})`
    ));
}

function linkifyMessageBody(body: string) {
  return body
    .split(FENCE_SPLIT)
    .map((segment) => {
      if (segment.startsWith("```")) return segment;
      return segment
        .split(INLINE_CODE_SPLIT)
        .map((inlineSegment) => inlineSegment.startsWith("`") ? inlineSegment : linkifyPlainText(inlineSegment))
        .join("");
    })
    .join("");
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

function CopyableCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromNode(children).replace(/\n$/, "");

  async function handleCopy() {
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="code-block-shell">
      <button type="button" onClick={handleCopy} aria-label="Copy code block">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function isolateLinkEvent(event: MouseEvent<HTMLAnchorElement> | PointerEvent<HTMLAnchorElement>) {
  event.stopPropagation();
}

function decodeLocalPath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function localEntityFromHref(href: string | undefined): LocalEntityLinkTarget | null {
  const match = href?.match(LOCAL_ENTITY_PATH_PATTERN);
  if (!match) return localHashEntityFromHref(href);
  const [, type, restWithQuery] = match;
  return localEntityFromPathParts(type, restWithQuery);
}

function localHashEntityFromHref(href: string | undefined): LocalEntityLinkTarget | null {
  if (!href) return null;
  const hashStart = href.indexOf("#/");
  if (hashStart < 0) return null;
  const hash = href.slice(hashStart);
  if (hash.startsWith("#/message/")) {
    const messageRef = decodeLocalPath(hash.replace("#/message/", ""));
    return messageRef ? { type: "message", messageRef } : null;
  }
  if (hash.startsWith("#/agent/")) {
    const handle = decodeLocalPath(hash.replace("#/agent/", ""));
    return handle ? { type: "agent", handle: handle.replace(/^@/, "") } : null;
  }
  if (hash.startsWith("#/task/")) {
    const taskNumber = Number(decodeLocalPath(hash.replace("#/task/", "")));
    return Number.isInteger(taskNumber) && taskNumber > 0 ? { type: "task", taskNumber } : null;
  }
  if (hash.startsWith("#/channel/")) {
    const [encodedChannelRef, maybeThreadSegment, encodedThreadRef] = hash
      .replace("#/channel/", "")
      .split("/");
    const channelRef = decodeLocalPath(encodedChannelRef);
    const threadRef = maybeThreadSegment === "thread" && encodedThreadRef ? decodeLocalPath(encodedThreadRef) : null;
    return channelRef ? { type: "channel", channelRef, threadRef } : null;
  }
  return null;
}

function localEntityFromPathParts(type: string, restWithQuery: string): LocalEntityLinkTarget | null {
  const rest = restWithQuery.split(/[?#]/, 1)[0];
  if (type === "agent") {
    const handle = decodeLocalPath(rest);
    return handle ? { type: "agent", handle: handle.replace(/^@/, "") } : null;
  }
  if (type === "message") {
    const messageRef = decodeLocalPath(rest);
    return messageRef ? { type: "message", messageRef } : null;
  }
  if (type === "task") {
    const taskNumber = Number(rest);
    return Number.isInteger(taskNumber) && taskNumber > 0 ? { type: "task", taskNumber } : null;
  }
  const [encodedChannelRef, maybeThreadSegment, encodedThreadRef] = rest.split("/");
  const channelRef = decodeLocalPath(encodedChannelRef);
  const threadRef = maybeThreadSegment === "thread" && encodedThreadRef ? decodeLocalPath(encodedThreadRef) : null;
  return channelRef ? { type: "channel", channelRef, threadRef } : null;
}

function isLocalHref(href: string | undefined) {
  return Boolean(localEntityFromHref(href));
}

function handleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  isLocalLink: boolean,
  onLocalAgentLink: ((handle: string) => void) | undefined,
  onLocalLink: ((target: LocalEntityLinkTarget) => void) | undefined,
) {
  event.stopPropagation();
  if (isLocalLink) {
    const target = localEntityFromHref(href);
    if (target && event.detail <= 1 && (onLocalLink || (target.type === "agent" && onLocalAgentLink))) {
      event.preventDefault();
      if (onLocalLink) onLocalLink(target);
      else if (target.type === "agent") onLocalAgentLink?.(target.handle);
    }
    return;
  }
  event.preventDefault();
  if (!href || event.detail > 1) return;

  void openExternalUrl(href).catch((err) => {
    console.error("Failed to open external link", err);
  });
}

function transformMessageUrl(url: string) {
  const localMatch = url.match(/^lantor:\/\/(agent|channel|message|task)\/(.+)$/i);
  if (localMatch) return `${LOCAL_ENTITY_HASH_PREFIX}${localMatch[1].toLowerCase()}/${localMatch[2]}`;
  return /^file:\/\//i.test(url) ? url : defaultUrlTransform(url);
}

function MessageMarkdownBody({ body, agentMentionLabels, onLocalAgentLink, onLocalLink }: MessageMarkdownProps) {
  const linkedBody = useMemo(() => linkifyMessageBody(body), [body]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transformMessageUrl}
        components={{
          a: ({ children, href, ...props }) => {
            const isLocalLink = isLocalHref(href);
            const localTarget = localEntityFromHref(href);
            const agentMentionLabel = localTarget?.type === "agent"
              ? agentMentionLabels?.[localTarget.handle.toLowerCase()] ?? null
              : null;
            const agentMentionHint = agentMentionLabel && localTarget?.type === "agent"
              ? `${agentMentionLabel} · @${localTarget.handle}`
              : null;
            const toolBrowserTarget = !isLocalLink ? toolBrowserTargetFromHref(href) : null;
            const renderedLink = (
              <a
                {...props}
                href={href}
                className={isLocalLink ? `local-entity-link${agentMentionHint ? " agent-mention-link" : ""}` : undefined}
                title={agentMentionHint ?? props.title}
                data-tooltip={agentMentionHint ?? undefined}
                target={isLocalLink ? undefined : "_blank"}
                rel={isLocalLink ? undefined : "noreferrer"}
                onPointerDown={isolateLinkEvent}
                onContextMenu={isolateLinkEvent}
                onClick={(event) => handleLinkClick(event, href, isLocalLink, onLocalAgentLink, onLocalLink)}
              >
                {agentMentionLabel ? `@${agentMentionLabel}` : children}
              </a>
            );
            if (!toolBrowserTarget) return renderedLink;
            return (
              <span className="tool-browser-link-shell">
                {renderedLink}
                <button
                  type="button"
                  className="tool-browser-link-button"
                  aria-label="Toggle embedded browser"
                  title="Toggle embedded browser"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dispatchToolBrowserToggle(toolBrowserTarget);
                  }}
                >
                  <AppWindow size={13} />
                  <span>Open in app</span>
                </button>
              </span>
            );
          },
          pre: ({ children }) => (
            <CopyableCodeBlock>{Children.toArray(children)}</CopyableCodeBlock>
          ),
        }}
      >
        {linkedBody}
      </ReactMarkdown>
    </div>
  );
}

const MemoizedMessageMarkdownBody = memo(MessageMarkdownBody);

export function MessageMarkdown({ body, agentMentionLabels, onLocalAgentLink, onLocalLink }: MessageMarkdownProps) {
  const agentLinkRef = useRef(onLocalAgentLink);
  const localLinkRef = useRef(onLocalLink);

  useEffect(() => {
    agentLinkRef.current = onLocalAgentLink;
    localLinkRef.current = onLocalLink;
  }, [onLocalAgentLink, onLocalLink]);

  const handleLocalAgentLink = useCallback((handle: string) => {
    agentLinkRef.current?.(handle);
  }, []);
  const handleLocalLink = useCallback((target: LocalEntityLinkTarget) => {
    localLinkRef.current?.(target);
  }, []);

  return (
    <MemoizedMessageMarkdownBody
      body={body}
      agentMentionLabels={agentMentionLabels}
      onLocalAgentLink={handleLocalAgentLink}
      onLocalLink={handleLocalLink}
    />
  );
}
