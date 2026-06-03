import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftAttachment } from "../types";
import { DraftAttachmentsPreview } from "./DraftAttachmentsPreview";

const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalWindow = globalThis.window;
const originalUrl = globalThis.URL;

function imageAttachment(overrides: Partial<DraftAttachment> = {}): DraftAttachment {
  return {
    id: "draft-image-1",
    file: new File(["image"], "screen.png", { type: "image/png" }),
    original_name: "screen.png",
    mime_type: "image/png",
    size_bytes: 5,
    ...overrides,
  };
}

function renderDraftPreview(onRemove = vi.fn()) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <DraftAttachmentsPreview attachments={[imageAttachment()]} onRemove={onRemove} />,
    );
  });
  return { renderer, onRemove };
}

describe("DraftAttachmentsPreview image lightbox", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: {
        createObjectURL: vi.fn(() => "blob:draft-preview"),
        revokeObjectURL: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as Partial<typeof globalThis>).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "URL", { configurable: true, value: originalUrl });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  it("opens draft image attachments in an isolated lightbox without removing them", () => {
    const { renderer, onRemove } = renderDraftPreview();
    const previewButton = renderer.root.findByProps({ "aria-label": "Preview screen.png" });

    act(() => {
      previewButton.props.onClick({ stopPropagation: vi.fn() });
    });

    expect(onRemove).not.toHaveBeenCalled();
    const lightbox = renderer.root.findByProps({ "aria-label": "Draft image preview" });
    expect(lightbox.props.role).toBe("dialog");
    expect(renderer.root.findByProps({ className: "attachment-lightbox-content" }).findByType("img").props.src)
      .toBe("blob:draft-preview");
  });

  it("keeps the remove button separate from image preview", () => {
    const { renderer, onRemove } = renderDraftPreview();
    const removeButton = renderer.root.findByProps({ "aria-label": "Remove screen.png" });

    act(() => {
      removeButton.props.onClick({ stopPropagation: vi.fn() });
    });

    expect(onRemove).toHaveBeenCalledWith("draft-image-1");
    expect(renderer.root.findAllByProps({ "aria-label": "Draft image preview" })).toHaveLength(0);
  });
});
