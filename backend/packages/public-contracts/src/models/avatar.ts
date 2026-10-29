import { z } from 'zod';

/**
 * Generated agent avatars (SPEC 2 "Avatars"): a rounded shape, a palette color,
 * a pair of eyes and an optional accessory — drawn from this small parameter object.
 */
export const avatarShapeSchema = z.enum([
  'circle',
  'squircle',
  'blob',
  // Added in v0.3 so each agent can have a distinct geometric silhouette.
  'triangle',
  'diamond',
  'hexagon',
]);
export type AvatarShape = z.infer<typeof avatarShapeSchema>;

export const avatarEyesSchema = z.enum(['dot', 'happy', 'sleepy', 'wide', 'wink', 'star']);
export type AvatarEyes = z.infer<typeof avatarEyesSchema>;

export const avatarAccessorySchema = z.enum([
  'none',
  'glasses',
  'headphones',
  'antenna',
  'cap',
  'bowtie',
  'crown',
]);
export type AvatarAccessory = z.infer<typeof avatarAccessorySchema>;

/**
 * Legacy Thumbs overrides. No longer drawn (every avatar is a character); kept
 * in the schema so stored agents still parse. Unknown legacy keys are stripped on parse.
 */
export const avatarThumbsSchema = z.object({
  /** Shape color as `#rrggbb`. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Thumbs color must be a #rrggbb hex color.')
    .optional(),
  /** Geometry seed override (bounded free-form string). */
  seed: z.string().min(1).max(128).optional(),
});
export type AvatarThumbs = z.infer<typeof avatarThumbsSchema>;

/**
 * The agent's rendered fluffy character (poster + sprite atlases bundled with the app). Absent: clients
 * pick one from a stable hash of the agent id (defaultCharacter), identically on web and iOS.
 */
export const avatarCharacterSchema = z.enum(['star', 'bean', 'mint', 'blue', 'purple', 'pink']);
export type AvatarCharacter = z.infer<typeof avatarCharacterSchema>;

export const avatarSpecSchema = z.object({
  shape: avatarShapeSchema,
  /** One of the 8 per-agent palette slots (`--agent-1 … --agent-8`). */
  color: z.number().int().min(1).max(8),
  eyes: avatarEyesSchema,
  accessory: avatarAccessorySchema.optional(),
  thumbs: avatarThumbsSchema.optional(),
  character: avatarCharacterSchema.optional(),
});
export type AvatarSpec = z.infer<typeof avatarSpecSchema>;
