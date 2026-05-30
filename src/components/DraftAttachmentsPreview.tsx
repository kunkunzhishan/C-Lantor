import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!isImage) {
      setObjectUrl("");
      return;
    }

    const nextUrl = URL.createObjectURL(attachment.file);
    setObjectUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [attachment.file, isImage]);

  if (isImage) {
    return (
      <div className="draft-attachment image">
        {objectUrl && <img src={objectUrl} alt="" />}
        <button
          type="button"
          className="draft-attachment-remove"
          onClick={() => onRemove(attachment.id)}
          aria-label={`Remove ${attachment.original_name || "image"}`}
        >
          <X size={14} />
        </button>
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
        onClick={() => onRemove(attachment.id)}
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
