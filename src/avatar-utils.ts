const DYLAN_DICEBEAR_STYLE = "dylan";

export type CuteAvatarPreset = {
  id: string;
  label: string;
  style: string;
  seedSuffix: string;
};

export const CUTE_AVATAR_PRESETS: CuteAvatarPreset[] = [
  { id: "lorelei-sweet", label: "Sweet", style: "lorelei", seedSuffix: "sweet" },
  { id: "lorelei-bubble", label: "Bubble", style: "lorelei", seedSuffix: "bubble" },
  { id: "adventurer-tiny", label: "Tiny", style: "adventurer", seedSuffix: "tiny" },
  { id: "adventurer-sunny", label: "Sunny", style: "adventurer", seedSuffix: "sunny" },
  { id: "notionists-cozy", label: "Cozy", style: "notionists", seedSuffix: "cozy" },
  { id: "personas-sticker", label: "Sticker", style: "personas", seedSuffix: "sticker" },
  { id: "pixel-buddy", label: "Pixel", style: "pixel-art", seedSuffix: "buddy" },
  { id: "dylan-soft", label: "Soft", style: "dylan", seedSuffix: "soft" },
  { id: "bot-buddy", label: "Bot", style: "bottts-neutral", seedSuffix: "buddy" },
  { id: "shape-candy", label: "Candy", style: "shapes", seedSuffix: "candy" },
];

function randomToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function seedPrefix(value: string) {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .toLowerCase();
}

export function randomDylanAvatarSpec(seedHint = "avatar") {
  const prefix = seedPrefix(seedHint) || "avatar";
  return `dicebear:${DYLAN_DICEBEAR_STYLE}:${prefix}-${randomToken()}`;
}

export function cuteAvatarSpec(preset: CuteAvatarPreset, seedHint = "avatar") {
  const prefix = seedPrefix(seedHint) || "avatar";
  return `dicebear:${preset.style}:${prefix}-${preset.seedSuffix}`;
}

export function randomCuteAvatarSpec(seedHint = "avatar") {
  const preset = CUTE_AVATAR_PRESETS[Math.floor(Math.random() * CUTE_AVATAR_PRESETS.length)];
  const prefix = seedPrefix(seedHint) || "avatar";
  return `dicebear:${preset.style}:${prefix}-${preset.seedSuffix}-${randomToken()}`;
}
