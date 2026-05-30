type KeyboardLikeEvent = {
  key: string;
  keyCode?: number;
  nativeEvent: {
    isComposing?: boolean;
  };
};

export function isImeComposing(event: KeyboardLikeEvent) {
  return Boolean(event.nativeEvent.isComposing) || event.key === "Process" || event.keyCode === 229;
}

export function insertTextAtSelection(
  value: string,
  insertion: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
) {
  const text = insertion.trim();
  if (!text) return { value, cursor: selectionEnd ?? value.length };
  const start = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
  const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
  const leading = start > 0 && !/\s$/.test(value.slice(0, start)) ? " " : "";
  const trailing = end < value.length && !/^\s/.test(value.slice(end)) ? " " : "";
  const inserted = `${leading}${text}${trailing}`;
  return {
    value: `${value.slice(0, start)}${inserted}${value.slice(end)}`,
    cursor: start + inserted.length,
  };
}
