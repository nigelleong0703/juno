import type { AvatarCharacter } from "@agent-desktop/client";
import mintSprite from "./mint/sprite.json";
import blueSprite from "./blue/sprite.json";
import purpleSprite from "./purple/sprite.json";
import pinkSprite from "./pink/sprite.json";
import starSprite from "./star/sprite.json";
import beanSprite from "./bean/sprite.json";

/** Rendered fluffy character avatars: a poster (rest pose) plus one sprite atlas per state (all share one layout). */
export type CharacterState = "happy" | "idle" | "thinking" | "working" | "needs_you" | "sleeping" | "failed";

export interface CharacterSprite {
  poster: string;
  atlases: Record<CharacterState, string>;
  /** Atlas layout: square cells of `frame` px, `cols` per row, `count` frames used (row-major). */
  frame: number;
  cols: number;
  count: number;
  fps: number;
  /** Rest-pose body box in cell px; the cell is scaled so the body fills the avatar box and the bounce overflows it. */
  body: { cx: number; cy: number; size: number };
}

/** Literal `new URL(..., import.meta.url)` is the form Vite bundles (hashed) and rewrites. */
export const CHARACTERS: Record<AvatarCharacter, CharacterSprite> = {
  mint: {
    poster: new URL("./mint/mint-poster.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./mint/mint-happy.webp", import.meta.url).href,
      idle: new URL("./mint/mint-idle.webp", import.meta.url).href,
      thinking: new URL("./mint/mint-thinking.webp", import.meta.url).href,
      working: new URL("./mint/mint-working.webp", import.meta.url).href,
      needs_you: new URL("./mint/mint-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./mint/mint-sleeping.webp", import.meta.url).href,
      failed: new URL("./mint/mint-failed.webp", import.meta.url).href,
    },
    ...mintSprite,
  },
  blue: {
    poster: new URL("./blue/blue-poster.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./blue/blue-happy.webp", import.meta.url).href,
      idle: new URL("./blue/blue-idle.webp", import.meta.url).href,
      thinking: new URL("./blue/blue-thinking.webp", import.meta.url).href,
      working: new URL("./blue/blue-working.webp", import.meta.url).href,
      needs_you: new URL("./blue/blue-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./blue/blue-sleeping.webp", import.meta.url).href,
      failed: new URL("./blue/blue-failed.webp", import.meta.url).href,
    },
    ...blueSprite,
  },
  purple: {
    poster: new URL("./purple/purple-poster.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./purple/purple-happy.webp", import.meta.url).href,
      idle: new URL("./purple/purple-idle.webp", import.meta.url).href,
      thinking: new URL("./purple/purple-thinking.webp", import.meta.url).href,
      working: new URL("./purple/purple-working.webp", import.meta.url).href,
      needs_you: new URL("./purple/purple-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./purple/purple-sleeping.webp", import.meta.url).href,
      failed: new URL("./purple/purple-failed.webp", import.meta.url).href,
    },
    ...purpleSprite,
  },
  pink: {
    poster: new URL("./pink/pink-poster.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./pink/pink-happy.webp", import.meta.url).href,
      idle: new URL("./pink/pink-idle.webp", import.meta.url).href,
      thinking: new URL("./pink/pink-thinking.webp", import.meta.url).href,
      working: new URL("./pink/pink-working.webp", import.meta.url).href,
      needs_you: new URL("./pink/pink-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./pink/pink-sleeping.webp", import.meta.url).href,
      failed: new URL("./pink/pink-failed.webp", import.meta.url).href,
    },
    ...pinkSprite,
  },
  star: {
    poster: new URL("./star/star.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./star/star-happy.webp", import.meta.url).href,
      idle: new URL("./star/star-idle.webp", import.meta.url).href,
      thinking: new URL("./star/star-thinking.webp", import.meta.url).href,
      working: new URL("./star/star-working.webp", import.meta.url).href,
      needs_you: new URL("./star/star-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./star/star-sleeping.webp", import.meta.url).href,
      failed: new URL("./star/star-failed.webp", import.meta.url).href,
    },
    ...starSprite,
  },
  bean: {
    poster: new URL("./bean/bean-poster.webp", import.meta.url).href,
    atlases: {
      happy: new URL("./bean/bean-happy.webp", import.meta.url).href,
      idle: new URL("./bean/bean-idle.webp", import.meta.url).href,
      thinking: new URL("./bean/bean-thinking.webp", import.meta.url).href,
      working: new URL("./bean/bean-working.webp", import.meta.url).href,
      needs_you: new URL("./bean/bean-needs_you.webp", import.meta.url).href,
      sleeping: new URL("./bean/bean-sleeping.webp", import.meta.url).href,
      failed: new URL("./bean/bean-failed.webp", import.meta.url).href,
    },
    ...beanSprite,
  },
};
