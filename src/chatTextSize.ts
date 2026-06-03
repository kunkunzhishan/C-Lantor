export const CHAT_TEXT_SIZE_STORAGE_KEY = "lantor.chatTextSize";

export const CHAT_TEXT_SIZE_OPTIONS = ["compact", "default", "large", "xlarge"] as const;

export type ChatTextSize = typeof CHAT_TEXT_SIZE_OPTIONS[number];

export const CHAT_TEXT_SIZE_LABELS: Record<ChatTextSize, { label: string; detail: string }> = {
  compact: { label: "Small", detail: "Compact UI" },
  default: { label: "Default", detail: "Current scale" },
  large: { label: "Large", detail: "More readable" },
  xlarge: { label: "Extra", detail: "Largest" },
};

export const CHAT_TEXT_SIZE_STYLES: Record<ChatTextSize, Record<string, string>> = {
  compact: {
    "--type-size-caption": "10px",
    "--type-size-meta": "11px",
    "--type-size-body": "13px",
    "--type-size-message": "14px",
    "--type-size-control": "15px",
    "--type-size-title": "17px",
    "--type-size-display": "20px",
  },
  default: {
    "--type-size-caption": "11px",
    "--type-size-meta": "12px",
    "--type-size-body": "13px",
    "--type-size-message": "15px",
    "--type-size-control": "16px",
    "--type-size-title": "20px",
    "--type-size-display": "22px",
  },
  large: {
    "--type-size-caption": "12px",
    "--type-size-meta": "13px",
    "--type-size-body": "14px",
    "--type-size-message": "16px",
    "--type-size-control": "17px",
    "--type-size-title": "22px",
    "--type-size-display": "24px",
  },
  xlarge: {
    "--type-size-caption": "13px",
    "--type-size-meta": "14px",
    "--type-size-body": "15px",
    "--type-size-message": "18px",
    "--type-size-control": "19px",
    "--type-size-title": "24px",
    "--type-size-display": "26px",
  },
};

export function isChatTextSize(value: unknown): value is ChatTextSize {
  return typeof value === "string" && CHAT_TEXT_SIZE_OPTIONS.includes(value as ChatTextSize);
}

export function storedChatTextSize(storage: Pick<Storage, "getItem">): ChatTextSize {
  const stored = storage.getItem(CHAT_TEXT_SIZE_STORAGE_KEY);
  return isChatTextSize(stored) ? stored : "default";
}

export function stepChatTextSize(current: ChatTextSize, delta: number): ChatTextSize {
  const currentIndex = CHAT_TEXT_SIZE_OPTIONS.indexOf(current);
  const defaultIndex = CHAT_TEXT_SIZE_OPTIONS.indexOf("default");
  const index = currentIndex >= 0 ? currentIndex : defaultIndex;
  const nextIndex = Math.min(
    CHAT_TEXT_SIZE_OPTIONS.length - 1,
    Math.max(0, index + delta),
  );
  return CHAT_TEXT_SIZE_OPTIONS[nextIndex] ?? "default";
}
