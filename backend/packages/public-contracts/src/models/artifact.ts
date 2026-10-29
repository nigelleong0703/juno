import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const artifactKindSchema = z.enum(['file', 'document', 'canvas', 'image']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** How a client shows a published artifact (BACKEND 5.11): a file card with preview, an interactive page in a sandboxed frame, an image, a video, or a running app. */
export const artifactRenderSchema = z.enum(['file', 'html', 'image', 'video', 'app', 'doc']);
export type ArtifactRender = z.infer<typeof artifactRenderSchema>;

/** 0.70 Documents (BACKEND 5.11a): the copy of a document that lives in another app (Google Docs, Notion). Approving a draft writes it there. */
export const documentTargetSchema = z.object({
  appId: idSchema,
  externalId: z.string().min(1),
  url: z.string().url(),
});
export type DocumentTarget = z.infer<typeof documentTargetSchema>;

/** MCP Apps `_meta.ui.csp.resourceDomains` semantics: extra https origins an HTML page may load scripts, styles, images, fonts and connections from. */
export const artifactCspSchema = z.object({
  resourceDomains: z.array(z.string().refine(isHttpsOrigin, { message: 'must be an https origin without path (https://host[:port])' })).max(20),
});
export type ArtifactCsp = z.infer<typeof artifactCspSchema>;

/** `https://host[:port]` with a plain DNS name or IPv4 host: no wildcard, path, credentials or CSP-breaking characters. */
function isHttpsOrigin(value: string): boolean {
  return /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(value);
}

/** One stored version of a published artifact. The refs are ids of private file rows, read through the version download. */
export const artifactVersionSchema = z.object({
  version: z.number().int().min(1),
  fileRef: idSchema,
  sizeBytes: z.number().int().min(0),
  mimeType: z.string(),
  sha256: z.string().optional(),
  /** PDF made from an Office file (docx/pptx/xlsx) in the agent's computer. */
  previewRef: idSchema.optional(),
  /** First-page PNG of a PDF or Office file; absent when the computer has no pdftoppm. */
  thumbnailRef: idSchema.optional(),
  /** HTML pages only: the origins the page declared (`<name>.csp.json`). */
  csp: artifactCspSchema.optional(),
  createdAt: isoDateTimeSchema,
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

/** Render by file extension for artifact_publish; undefined means "not publishable, use send_file". */
export function artifactRenderForName(name: string): ArtifactRender | undefined {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'pdf':
    case 'docx':
    case 'pptx':
    case 'xlsx':
    case 'md':
      return 'file';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
      return 'image';
    case 'mp4':
    case 'webm':
      return 'video';
    default:
      return undefined;
  }
}

/** Anything an agent produces or the user uploads (SPEC 4.11 Library, §5.3 ArtifactCard). */
export const artifactSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  kind: artifactKindSchema,
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  createdByAgentId: idSchema.optional(),
  conversationId: idSchema.optional(),
  runId: idSchema.optional(),
  shared: z.enum(['private', 'team']),
  source: z.enum(['agent', 'upload']),
  previewUrl: z.string().optional(),
  /** Published artifacts only (artifact_publish; absent on uploads and send_file rows). `version` is the newest; `versions` is oldest first. */
  render: artifactRenderSchema.optional(),
  version: z.number().int().min(1).optional(),
  versions: z.array(artifactVersionSchema).optional(),
  /** 0.7: `render: 'app'` only: the Space this card opens (no versions; `GET /v1/spaces/:id` has its status). */
  spaceId: idSchema.optional(),
  /** 0.70: `render: 'doc'` only: the external copy this document is written to on approval. `version` is the saved head (absent until the first approval). */
  target: documentTargetSchema.optional(),
  /** Pixel size of an image, when known (absent on older rows and non-images). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  tags: z.array(z.string()),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

/** Library entry: an artifact plus library-only metadata (pin, folder). */
export const libraryItemSchema = artifactSchema.extend({
  pinned: z.boolean(),
  folder: z.string().optional(),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

/** Owner-scoped binary download for one saved file (PD3). Never embedded in list/get metadata. */
export const fileDownloadSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256: z.string().min(1).optional(),
});
export type FileDownload = z.infer<typeof fileDownloadSchema>;

/** 0.7 Spaces (BACKEND 5.12): where an agent's small app is right now. `unknown` = the computer did not answer. */
export const spaceStatusSchema = z.enum(['running', 'computer_paused', 'not_listening', 'unknown']);
export type SpaceStatus = z.infer<typeof spaceStatusSchema>;

/** 0.59 hosted Spaces (BACKEND 5.12, option B): who may open the published copy. `link` = anyone with the link; `public` = the same, and search engines may index it; `private` = only the owner, through the owner link. */
export const spaceVisibilitySchema = z.enum(['private', 'link', 'public']);
export type SpaceVisibility = z.infer<typeof spaceVisibilitySchema>;

/** A Space published to long-lived hosting: its share link. A revoked link is not returned (its URL answers 404). */
export const spaceHostedSchema = z.object({
  spaceId: idSchema,
  /** The share link (`https://<slug>-<linkId>.<content domain>/`). */
  url: z.string().min(1),
  visibility: spaceVisibilitySchema,
  /** Whether visitors (people without the owner's session) may change the Space's data. They may always read it; the owner always may change it. */
  visitorWrites: z.boolean(),
  /** Each publish of the Space (the first and every republish) is a new version at the same URL. */
  version: z.number().int().min(1),
  publishedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SpaceHosted = z.infer<typeof spaceHostedSchema>;

/** Body of `POST /v1/spaces/:id/publish-hosted`: the access of a new link (default: `link`, visitors read-only); a republish keeps the access unless one is given. */
export const spacePublishHostedSchema = z.object({ visibility: spaceVisibilitySchema.optional(), visitorWrites: z.boolean().optional() });
export type SpacePublishHosted = z.infer<typeof spacePublishHostedSchema>;

/** Body of `PATCH /v1/spaces/:id/hosted`: at least one of the two. */
export const spaceHostedUpdateSchema = z
  .object({ visibility: spaceVisibilitySchema.optional(), visitorWrites: z.boolean().optional() })
  .refine((body) => body.visibility !== undefined || body.visitorWrites !== undefined, { message: 'name the visibility or visitorWrites to change' });
export type SpaceHostedUpdate = z.infer<typeof spaceHostedUpdateSchema>;

/** An app an agent built and published from its own computer; only its owner can open it. */
export const spaceSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  slug: z.string().min(1),
  agentId: idSchema,
  /** The chat card (`render: 'app'` artifact) of this app. */
  artifactId: idSchema,
  status: spaceStatusSchema,
  /** Present once the app is published to long-lived hosting and the link is not revoked. */
  hosted: spaceHostedSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Space = z.infer<typeof spaceSchema>;

/** A 5-minute sign-in link on the app's own origin; opening it sets that origin's session cookie. */
export const spaceOpenUrlSchema = z.object({ url: z.string().min(1), expiresAt: isoDateTimeSchema });
export type SpaceOpenUrl = z.infer<typeof spaceOpenUrlSchema>;
