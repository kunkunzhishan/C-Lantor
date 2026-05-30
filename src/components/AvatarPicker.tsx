import { useMemo, useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import { CUTE_AVATAR_PRESETS, cuteAvatarSpec } from "../avatar-utils";
import { AgentAvatar } from "./AgentAvatar";

type AvatarPickerProps = {
  value: string;
  seedHint: string;
  onChange: (avatar: string) => void;
};

const AVATAR_UPLOAD_SIZE = 256;
const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;

function randomGenerationToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image file"));
    };
    image.src = url;
  });
}

async function fileToAvatarDataUrl(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file");
  }
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
    throw new Error("Image must be smaller than 8 MB");
  }

  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceSize = Math.min(sourceWidth, sourceHeight);
  if (!sourceSize) {
    throw new Error("Image has no readable size");
  }

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_UPLOAD_SIZE;
  canvas.height = AVATAR_UPLOAD_SIZE;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Image processing is unavailable");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    Math.floor((sourceWidth - sourceSize) / 2),
    Math.floor((sourceHeight - sourceSize) / 2),
    sourceSize,
    sourceSize,
    0,
    0,
    AVATAR_UPLOAD_SIZE,
    AVATAR_UPLOAD_SIZE,
  );
  return canvas.toDataURL("image/png");
}

export function AvatarPicker({ value, seedHint, onChange }: AvatarPickerProps) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState("default");
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const options = useMemo(() => CUTE_AVATAR_PRESETS.map((preset) => ({
    ...preset,
    avatar: cuteAvatarSpec(preset, `${seedHint}:${generation}`),
  })), [generation, seedHint]);
  const selectedOption = options.find((option) => option.avatar === value.trim());
  const currentAgent = {
    id: "avatar-picker-current",
    handle: "avatar",
    display_name: selectedOption?.label ?? "Custom",
    status: "idle",
    avatar: value,
  };
  const selectedLabel = value.trim().startsWith("data:image/") ? "Uploaded" : selectedOption?.label ?? "Custom";

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    try {
      setUploadError("");
      onChange(await fileToAvatarDataUrl(file));
      setOpen(false);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not use this image");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="avatar-picker">
      <button
        type="button"
        className="avatar-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <AgentAvatar agent={currentAgent} size="md" showStatus={false} />
        <span>Avatar</span>
        <strong>{selectedLabel}</strong>
      </button>
      {open ? (
        <>
          <div className="avatar-picker-toolbar">
            <span>Pick one or refresh for more</span>
            <button
              type="button"
              className="avatar-picker-refresh"
              onClick={() => setGeneration(randomGenerationToken())}
              title="Refresh avatar options"
              aria-label="Refresh avatar options"
            >
              <RefreshCw size={15} />
              <span>Refresh</span>
            </button>
          </div>
          <div className="avatar-picker-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                void handleUpload(event.target.files?.[0]);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} />
              <span>Upload image</span>
            </button>
            <span>Square crop, 256px</span>
          </div>
          {uploadError ? <div className="avatar-picker-error">{uploadError}</div> : null}
          <div className="avatar-picker-grid">
            {options.map((option) => {
              const selected = value.trim() === option.avatar;
              const previewAgent = {
                id: `avatar-preset-${option.id}`,
                handle: option.id,
                display_name: option.label,
                status: "idle",
                avatar: option.avatar,
              };
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`avatar-picker-option ${selected ? "selected" : ""}`}
                  onClick={() => {
                    onChange(option.avatar);
                    setOpen(false);
                  }}
                  aria-pressed={selected}
                  title={option.label}
                >
                  <AgentAvatar agent={previewAgent} size="md" showStatus={false} />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
          <label className="avatar-picker-custom">
            <span>Custom</span>
            <input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder="emoji, image URL, or dicebear:style:seed"
            />
          </label>
        </>
      ) : null}
    </div>
  );
}
