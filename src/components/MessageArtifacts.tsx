import { Component, ReactNode, useEffect, useState } from "react";
import { BookOpen, Copy, Download, FileDiff, FileText, ScrollText, Search } from "lucide-react";
import { apiInvoke } from "../apiClient";
import { copyText } from "../clipboard";
import { Artifact } from "../types";
import { MessageMarkdown } from "./MessageMarkdown";

type MessageArtifactsProps = {
  artifacts?: Artifact[] | null;
  onOpenArtifact?: (artifact: Artifact) => void;
};

type SafeArtifact = Artifact & {
  id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
};

type ArtifactErrorBoundaryProps = {
  artifactTitle: string;
  children: ReactNode;
};

type ArtifactErrorBoundaryState = {
  failed: boolean;
};

class ArtifactErrorBoundary extends Component<ArtifactErrorBoundaryProps, ArtifactErrorBoundaryState> {
  state: ArtifactErrorBoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="artifact-render-error">
          Could not render artifact "{this.props.artifactTitle}". Open the full artifact or retry after reload.
        </div>
      );
    }
    return this.props.children;
  }
}

function asText(value: unknown, fallback = "") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function normalizeKind(kind: unknown) {
  return asText(kind, "text").trim().toLowerCase() || "text";
}

export function isAutoLongMessageArtifact(artifact: Partial<Artifact> | null | undefined) {
  return artifact?.metadata?.source === "auto_long_message";
}

export function isLongMessageFallbackArtifact(artifact: Partial<Artifact> | null | undefined) {
  return artifact?.metadata?.source === "long_message_fallback";
}

function safeArtifact(artifact: Partial<Artifact> | null | undefined, index: number): SafeArtifact {
  return {
    ...(artifact ?? {}),
    id: asText(artifact?.id, `artifact-${index}`),
    message_id: asText(artifact?.message_id),
    channel_id: asText(artifact?.channel_id),
    thread_root_id: typeof artifact?.thread_root_id === "string" ? artifact.thread_root_id : null,
    creator_agent_id: typeof artifact?.creator_agent_id === "string" ? artifact.creator_agent_id : null,
    creator_agent_handle: typeof artifact?.creator_agent_handle === "string" ? artifact.creator_agent_handle : null,
    kind: normalizeKind(artifact?.kind),
    title: asText(artifact?.title, "Untitled artifact"),
    summary: asText(artifact?.summary),
    content: asText(artifact?.content),
    metadata: artifact?.metadata && typeof artifact.metadata === "object" ? artifact.metadata : {},
    created_at: asText(artifact?.created_at),
    updated_at: asText(artifact?.updated_at),
  };
}

function safeKindClass(kind: string) {
  return kind.replace(/[^a-z0-9_-]/g, "-") || "text";
}

function inferredArtifactType(artifact: Artifact) {
  const explicitType = asText(artifact.metadata?.artifact_type).trim().toLowerCase();
  if (["report", "research", "patch", "log"].includes(explicitType)) return explicitType;
  const haystack = `${artifact.kind} ${artifact.title}`.toLowerCase();
  if (haystack.includes("research")) return "research";
  if (haystack.includes("report")) return "report";
  if (haystack.includes("patch") || haystack.includes("diff")) return "patch";
  if (haystack.includes("log")) return "log";
  return artifact.kind || "text";
}

function artifactIcon(type: string) {
  if (type === "research") return Search;
  if (type === "report") return BookOpen;
  if (type === "patch") return FileDiff;
  if (type === "log") return ScrollText;
  return FileText;
}

function previewContent(artifact: Artifact) {
  const content = asText(artifact.summary || artifact.content);
  const compact = content.trim().replace(/\s+/g, " ");
  return compact.length > 140 ? `${compact.slice(0, 140)}...` : compact;
}

function ArtifactContent({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "markdown") {
    return (
      <div className="artifact-markdown-content">
        <MessageMarkdown body={artifact.content || previewContent(artifact)} />
      </div>
    );
  }

  return <pre>{artifact.content || previewContent(artifact)}</pre>;
}

function metadataNumber(artifact: Artifact, key: string) {
  const value = artifact.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function downloadArtifact(artifact: Artifact) {
  const extension = artifact.kind === "markdown" ? "md" : "txt";
  const safeTitle = artifact.title.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "artifact";
  const url = URL.createObjectURL(new Blob([artifact.content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeTitle}.${extension}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ArtifactCard({ artifact, onOpenArtifact }: { artifact: SafeArtifact; onOpenArtifact?: (artifact: Artifact) => void }) {
  const [fullArtifact, setFullArtifact] = useState<SafeArtifact>(artifact);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const type = inferredArtifactType(fullArtifact);
  const Icon = artifactIcon(type);
  const lineCount = metadataNumber(fullArtifact, "line_count");
  const charCount = metadataNumber(fullArtifact, "char_count");
  const codeBlockCount = metadataNumber(fullArtifact, "code_block_count");

  useEffect(() => {
    setFullArtifact((current) => ({
      ...artifact,
      content: artifact.content || current.content,
    }));
  }, [artifact]);

  async function ensureFullArtifact() {
    if (fullArtifact.content) return fullArtifact;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = safeArtifact(await apiInvoke<Artifact>("artifact_read", { artifactId: artifact.id }), 0);
      setFullArtifact(loaded);
      return loaded;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the full artifact.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpanded() {
    if (!expanded && !await ensureFullArtifact()) return;
    setExpanded((current) => !current);
  }

  async function handleCopy() {
    const loaded = await ensureFullArtifact();
    if (!loaded) return;
    await copyText(loaded.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  async function handleDownload() {
    const loaded = await ensureFullArtifact();
    if (loaded) downloadArtifact(loaded);
  }

  return (
    <section className={`message-artifact artifact-${safeKindClass(type)} ${
      isAutoLongMessageArtifact(artifact)
        ? "auto-long-message"
        : isLongMessageFallbackArtifact(artifact)
          ? "long-message-fallback-artifact"
          : ""
    }`}>
      <header className="message-artifact-head">
        <span className="artifact-icon"><Icon size={16} /></span>
        <span>
          <strong>{fullArtifact.title}</strong>
          <small>
            {type}
            {lineCount !== null ? ` · ${lineCount.toLocaleString()} lines` : ""}
            {charCount !== null ? ` · ${charCount.toLocaleString()} characters` : ""}
            {codeBlockCount !== null ? ` · ${codeBlockCount.toLocaleString()} code blocks` : ""}
          </small>
        </span>
      </header>
      {fullArtifact.summary && (
        <div className="artifact-preview">
          <MessageMarkdown body={fullArtifact.summary} />
        </div>
      )}
      {expanded && fullArtifact.content && (
        <div className="artifact-expanded-content">
          <ArtifactContent artifact={fullArtifact} />
        </div>
      )}
      {loadError && <div className="artifact-render-error">{loadError}</div>}
      <div className="artifact-actions">
        <button type="button" disabled={loading} onClick={() => void toggleExpanded()}>
          {loading ? "Loading…" : expanded ? "Collapse" : "Expand"}
        </button>
        <button type="button" disabled={loading} onClick={() => void handleCopy()}>
          <Copy size={13} /> {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" disabled={loading} onClick={() => void handleDownload()}>
          <Download size={13} /> Download
        </button>
        {onOpenArtifact && (
          <button type="button" onClick={() => onOpenArtifact(fullArtifact)}>Open</button>
        )}
      </div>
    </section>
  );
}

export function MessageArtifacts({ artifacts, onOpenArtifact }: MessageArtifactsProps) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;

  return (
    <div className="message-artifacts">
      {artifacts.map((rawArtifact, index) => {
        const artifact = safeArtifact(rawArtifact, index);
        return (
          <ArtifactErrorBoundary key={artifact.id || `artifact-${index}`} artifactTitle={artifact.title}>
            <ArtifactCard artifact={artifact} onOpenArtifact={onOpenArtifact} />
          </ArtifactErrorBoundary>
        );
      })}
    </div>
  );
}
