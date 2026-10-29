import type { AvatarCharacter } from "@agent-desktop/client";
import type { CSSProperties } from "react";

/**
 * Every agent avatar is one of the six fluffy characters (characters/, VISUAL.md "Avatars"). An agent
 * without a saved `avatar.character` gets one from a stable hash of its id, so the same agent draws the
 * same character on every surface, reload and device. The list order and the FNV-1a hash are mirrored by
 * iOS (Avatar.swift defaultCharacter); change them together.
 */
export const CHARACTER_ORDER: readonly AvatarCharacter[] = ["mint", "blue", "purple", "pink", "star", "bean"];

/** Soft per-character accent (home aurora, agent-card wash). */
export const CHARACTER_TINT: Record<AvatarCharacter, string> = {
  mint: "#4fd1b0",
  blue: "#5b8def",
  purple: "#9b7bf0",
  pink: "#f08bb4",
  star: "#f5b48a",
  bean: "#f5c542",
};

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable default character for an agent id. */
export function defaultCharacter(agentId: string): AvatarCharacter {
  return CHARACTER_ORDER[hashString(agentId) % CHARACTER_ORDER.length] ?? "bean";
}

/** The character an agent is drawn as: the saved choice, else the id-derived default. */
export function agentCharacter(agentId: string, avatar?: { character?: AvatarCharacter }): AvatarCharacter {
  return avatar?.character ?? defaultCharacter(agentId);
}

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance; iOS `onColor`). */
export function onColor(hex: string): string {
  const channel = (offset: number): number => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "#141414" : "#ffffff";
}

/** CSS variables that tint a direct chat with the agent's character colour (user bubble, send button, top wash). */
export function agentAccentStyle(agentId: string, avatar?: { character?: AvatarCharacter }): CSSProperties {
  const tint = CHARACTER_TINT[agentCharacter(agentId, avatar)];
  return { ["--agent-accent" as string]: tint, ["--agent-accent-fg" as string]: onColor(tint) };
}
