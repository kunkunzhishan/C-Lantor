import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Copy, Download, Minus, Plus } from "lucide-react";
import { copyText } from "../clipboard";
import type { Artifact } from "../types";
import { MessageMarkdown } from "./MessageMarkdown";
import { Modal } from "./Modal";

const DEFAULT_FONT_SCALE = 100;
const MIN_FONT_SCALE = 50;
const MAX_FONT_SCALE = 250;
const FONT_SCALE_STEP = 10;

export function normalizedArtifactFontScale(value: string | number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FONT_SCALE;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, Math.round(parsed)));
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

type ArtifactReaderModalProps = {
  artifact: Artifact | null;
  onClose: () => void;
};

export function ArtifactReaderModal({ artifact, onClose }: ArtifactReaderModalProps) {
  const [fontScaleDraft, setFontScaleDraft] = useState(String(DEFAULT_FONT_SCALE));
  const [fontScalePercent, setFontScalePercent] = useState(DEFAULT_FONT_SCALE);

  useEffect(() => {
    setFontScaleDraft(String(DEFAULT_FONT_SCALE));
    setFontScalePercent(DEFAULT_FONT_SCALE);
  }, [artifact?.id]);

  function applyDraft() {
    const next = normalizedArtifactFontScale(fontScaleDraft);
    setFontScalePercent(next);
    setFontScaleDraft(String(next));
  }

  function adjust(delta: number) {
    const next = normalizedArtifactFontScale(fontScalePercent + delta);
    setFontScalePercent(next);
    setFontScaleDraft(String(next));
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDraft();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFontScaleDraft(String(fontScalePercent));
    }
  }

  const readerStyle = {
    "--artifact-reader-font-scale": fontScalePercent / 100,
  } as CSSProperties;

  return (
    <Modal
      open={Boolean(artifact)}
      title={artifact?.title || "Artifact Reader"}
      onClose={onClose}
      width={980}
    >
      {artifact && (
        <div className="artifact-reader" style={readerStyle}>
          <div className="artifact-reader-toolbar">
            <div className="artifact-reader-font-controls" aria-label="Reader font size">
              <button
                type="button"
                aria-label="Decrease font size"
                disabled={fontScalePercent <= MIN_FONT_SCALE}
                onClick={() => adjust(-FONT_SCALE_STEP)}
              >
                <Minus size={15} />
              </button>
              <label>
                <span className="sr-only">Font size percent</span>
                <input
                  aria-label="Font size percent"
                  inputMode="numeric"
                  value={fontScaleDraft}
                  onChange={(event) => setFontScaleDraft(event.target.value)}
                  onBlur={applyDraft}
                  onKeyDown={handleInputKeyDown}
                />
                <span>%</span>
              </label>
              <button
                type="button"
                aria-label="Increase font size"
                disabled={fontScalePercent >= MAX_FONT_SCALE}
                onClick={() => adjust(FONT_SCALE_STEP)}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="artifact-reader-actions">
              <button type="button" onClick={() => void copyText(artifact.content)}>
                <Copy size={15} /> Copy
              </button>
              <button type="button" onClick={() => downloadArtifact(artifact)}>
                <Download size={15} /> Download
              </button>
            </div>
          </div>
          <div className="artifact-reader-content">
            {artifact.kind === "markdown"
              ? <MessageMarkdown body={artifact.content} />
              : <pre>{artifact.content}</pre>}
          </div>
        </div>
      )}
    </Modal>
  );
}
