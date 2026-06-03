import { type MouseEvent, type PointerEvent, useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { DraftAttachment } from "../types";

type DraftAttachmentsPreviewProps = {
  attachments: DraftAttachment[];
  onRemove: (id: string) => void;
};

type DraftAttachmentPreviewItemProps = {
  attachment: DraftAttachment;
  onRemove: (id: string) => void;
};

function DraftAttachmentPreviewItem({ attachment, onRemove }: DraftAttachmentPreviewItemProps) {
  const isImage = attachment.mime_type.startsWith("image/");
  const [objectUrl, setObjectUrl] = useState("");
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  useEffect(() => {
    if (!isImage) {
      setObjectUrl("");
      return;
    }

    const nextUrl = URL.createObjectURL(attachment.file);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [attachment.file, isImage]);

  useEffect(() => {
    if (!isPreviewOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsPreviewOpen(false);
    }
    function handleHistoryNavigation() {
      setIsPreviewOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("popstate", handleHistoryNavigation);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("popstate", handleHistoryNavigation);
    };
  }, [isPreviewOpen]);

  function isolateDraftAttachmentEvent(event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function closeImagePreview(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsPreviewOpen(false);
  }

  if (isImage) {
    const previewLabel = `Preview ${attachment.original_name || "image"}`;
    return (
      <div className="draft-attachment image">
        {objectUrl && (
          <button
            type="button"
            className="draft-attachment-preview"
            aria-label={previewLabel}
            onPointerDown={isolateDraftAttachmentEvent}
            onClick={(event) => {
              event.stopPropagation();
              setIsPreviewOpen(true);
            }}
          >
            <img src={objectUrl} alt="" />
          </button>
        )}
        <button
          type="button"
          className="draft-attachment-remove"
          onPointerDown={isolateDraftAttachmentEvent}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(attachment.id);
          }}
          aria-label={`Remove ${attachment.original_name || "image"}`}
        >
          <X size={14} />
        </button>
        {isPreviewOpen && objectUrl && (
          <div
            className="attachment-lightbox draft-attachment-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Draft image preview"
            onPointerDown={isolateDraftAttachmentEvent}
            onClick={isolateDraftAttachmentEvent}
          >
            <button
              type="button"
              className="attachment-lightbox-backdrop"
              aria-label="Close draft image preview"
              onPointerDown={isolateDraftAttachmentEvent}
              onClick={closeImagePreview}
            />
            <button
              type="button"
              className="attachment-lightbox-close"
              aria-label="Close draft image preview"
              onPointerDown={isolateDraftAttachmentEvent}
              onClick={closeImagePreview}
            >
              <X size={18} />
            </button>
            <div className="attachment-lightbox-content">
              <img src={objectUrl} alt={attachment.original_name || "Draft attachment preview"} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="draft-attachment file">
      <FileText size={14} />
      <span>{attachment.original_name || "attachment"}</span>
      <button
        type="button"
        className="draft-attachment-remove"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(attachment.id);
        }}
        aria-label={`Remove ${attachment.original_name || "attachment"}`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function DraftAttachmentsPreview({ attachments, onRemove }: DraftAttachmentsPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="draft-attachments">
      {attachments.map((attachment) => (
        <DraftAttachmentPreviewItem
          key={attachment.id}
          attachment={attachment}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
