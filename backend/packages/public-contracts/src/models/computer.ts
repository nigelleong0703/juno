import { z } from 'zod';
import {
  computerControllerSchema,
  computerStateSchema,
  idSchema,
  isoDateTimeSchema,
} from './common.js';

export const resourceMeterSchema = z.object({
  used: z.number().min(0),
  total: z.number().min(0),
  unit: z.string(),
});
export type ResourceMeter = z.infer<typeof resourceMeterSchema>;

export const computerResourcesSchema = z.object({
  cpu: resourceMeterSchema.extend({
    /** Number of virtual cores; `used` is a percentage 0..100. */
    cores: z.number().int().min(1),
  }),
  memory: resourceMeterSchema,
  disk: resourceMeterSchema,
});
export type ComputerResources = z.infer<typeof computerResourcesSchema>;

/**
 * Lifecycle of one agent's X display inside the shared sandbox (BACKEND §7.1). `starting` while
 * Xvfb/x11vnc come up, `live` while watchable, `asleep` after the idle-stop, `stopped` when freed.
 */
export const screenStateSchema = z.enum(['starting', 'live', 'asleep', 'error', 'stopped']);
export type ScreenState = z.infer<typeof screenStateSchema>;

/**
 * One agent's screen as carried on `Computer.screens` (BACKEND §12 / SB1 contract §4). This is the
 * client-visible projection: no VNC password ever appears here, and the stream is granted through a
 * short-lived signed ticket instead.
 */
export const computerScreenSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** X display number; `DISPLAY=:${displayNo}`. */
  displayNo: z.number().int().min(1),
  state: screenStateSchema,
  controller: computerControllerSchema,
  title: z.string(),
});
export type ComputerScreen = z.infer<typeof computerScreenSchema>;

/** The redacted screen the public API returns (SB1 contract §3). */
export const screenResponseSchema = computerScreenSchema.extend({
  ownerId: idSchema,
  computerId: idSchema,
  controllerSince: isoDateTimeSchema.optional(),
  /** Bumped on every change of who holds the screen (0.71.0, unreleased); a take-over or return that passes the epoch it saw is refused when it is stale. */
  controlEpoch: z.number().int().min(0),
  resolution: z.string(),
  lastUsedAt: isoDateTimeSchema,
});
export type ScreenResponse = z.infer<typeof screenResponseSchema>;

/**
 * A signed, short-lived grant for one screen's websocket. The `url` is absolute
 * (`ws://host/v1/screens/:id/vnc?t=…`) and is the *only* credential the renderer holds: the VNC
 * password is filled in server-side by the agentd↔computerd proxy (BACKEND §7.2).
 */
export const screenStreamTicketSchema = z.object({
  url: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});
export type ScreenStreamTicket = z.infer<typeof screenStreamTicketSchema>;

/** A captured screen frame (base64 PNG/JPEG + pixel size and display number). */
export const screenScreenshotSchema = z.object({
  data: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
  displayNo: z.number().int().min(1).optional(),
});
export type ScreenScreenshot = z.infer<typeof screenScreenshotSchema>;

/**
 * A rectangle on a screen, in framebuffer pixels of that screen's VNC stream (origin top-left; the
 * screen's `resolution` is the framebuffer size). Clients scale it with the same factor they draw the
 * stream at, so a rect lands on the element it names.
 */
export const screenRectSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type ScreenRect = z.infer<typeof screenRectSchema>;

/** One visible interactive control on a screen (a tap target); `name` is untrusted page text. */
export const screenElementSchema = z.object({
  rect: screenRectSchema,
  role: z.string().min(1),
  name: z.string(),
});
export type ScreenElement = z.infer<typeof screenElementSchema>;

/**
 * `GET /v1/screens/:id/elements`: the visible interactive controls of the page on the screen, so a
 * client can snap a fingertip tap to the nearest one while the user controls the screen.
 * `width`/`height` are the framebuffer size the rects are measured in.
 */
export const screenElementsSchema = z.object({
  screenId: idSchema,
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  elements: z.array(screenElementSchema).max(300),
});
export type ScreenElements = z.infer<typeof screenElementsSchema>;

/** Files in one paste to the computer. */
export const SCREEN_CLIPBOARD_MAX_FILES = 10;

/**
 * The clipboard side channel (M-CLIP). VNC cut-text carries text only, so an image or a file goes through computerd:
 * `POST …/clipboard` puts what the device copied on the computer (an image goes on its clipboard; files are saved to the
 * agent's Downloads), and `GET …/clipboard` returns what the computer copied. Both need the user to hold the screen, and
 * every payload is capped at the app upload limit (`MAX_UPLOAD_BYTES`, decoded size).
 */
export const screenClipboardPasteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    mimeType: z.enum(['image/png', 'image/jpeg']),
    contentBase64: z.string().min(1),
  }),
  z.object({
    kind: z.literal('files'),
    files: z
      .array(z.object({ name: z.string().min(1).max(255), contentBase64: z.string().min(1) }))
      .min(1)
      .max(SCREEN_CLIPBOARD_MAX_FILES),
  }),
]);
export type ScreenClipboardPaste = z.infer<typeof screenClipboardPasteSchema>;

/** Where the computer put what was pasted: an image path (its clipboard now holds it) or the saved files, under the agent's home. */
export const screenClipboardPasteResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), path: z.string().min(1) }),
  z.object({
    kind: z.literal('files'),
    saved: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })),
  }),
]);
export type ScreenClipboardPasteResult = z.infer<typeof screenClipboardPasteResultSchema>;

/**
 * What the computer's clipboard held after the user's copy: `text`, a PNG `image`, or a `file` (the first file of a copied
 * file list, with its bytes). `empty` means nothing was selected there.
 */
export const screenClipboardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('image'), mimeType: z.literal('image/png'), contentBase64: z.string().min(1) }),
  z.object({ kind: z.literal('file'), name: z.string().min(1), sizeBytes: z.number().int().min(0), contentBase64: z.string() }),
]);
export type ScreenClipboard = z.infer<typeof screenClipboardSchema>;

export const updateScheduleSchema = z.object({
  kind: z.enum(['auto', 'manual', 'window']),
  /** e.g. "Sun 03:00". */
  window: z.string().optional(),
  tz: z.string().optional(),
});
export type UpdateSchedule = z.infer<typeof updateScheduleSchema>;

export const computerSchema = z.object({
  id: idSchema,
  /**
   * The agents that share this computer. Owner decision 2026-10-05: every agent of a user shares
   * ONE computer with ONE screen (like Grok Bot), so only one agent drives the screen at a time.
   */
  agentIds: z.array(idSchema),
  /** The agent currently driving the screen; null when nobody is (others queue for it). */
  activeAgentId: idSchema.nullable(),
  /**
   * One entry per agent that has been given its own X display (BACKEND §7.1). Optional so the seed
   * world and older projections keep parsing; a real backend populates it and the pane then selects
   * the screen belonging to the agent in view.
   */
  screens: z.array(computerScreenSchema).optional(),
  name: z.string().min(1),
  state: computerStateSchema,
  controller: computerControllerSchema,
  resources: computerResourcesSchema,
  /** Shape requested at creation: vCPU + RAM (SPEC 4.12 "Computer"). */
  size: z.object({
    vcpu: z.number().int().min(1),
    ramGb: z.number().min(1),
    diskGb: z.number().min(1),
  }),
  /** Pause the computer after N idle minutes. */
  idlePauseMinutes: z.number().int().min(0),
  updateSchedule: updateScheduleSchema,
  uptimeSeconds: z.number().int().min(0),
  os: z.string(),
  resolution: z.string(),
  filesUrl: z.string().optional(),
  lastUpdatedAt: isoDateTimeSchema,
});
export type Computer = z.infer<typeof computerSchema>;

/** The owner's Mac as a computer (My Mac): whether one is paired and whether its link is up right now. */
export const macStatusSchema = z.object({
  paired: z.boolean(),
  online: z.boolean(),
  /** What the owner named it, e.g. "Robin's MacBook Pro". */
  name: z.string().optional(),
  pairedAt: isoDateTimeSchema.optional(),
  /** The Mac user the agent's commands run as. */
  user: z.string().optional(),
  /** The folder the agent works in on the Mac (`~/Juno`, as an absolute path). */
  folder: z.string().optional(),
  /**
   * 0.71.0 (unreleased): present while the person has Stopped the Mac (pressing Stop on the Mac, "Stop all tab access" in the Chrome extension,
   * or Stop from a phone). Agents cannot use the Mac until it is resumed on the Mac itself; there is no remote resume.
   */
  stopped: z.object({ since: isoDateTimeSchema, epoch: z.number().int().min(0) }).optional(),
  /** What the connected Mac declared it can do right now; absent while offline. Actions the user has not granted on the Mac are not listed. */
  device: z.object({
    deviceId: z.string(),
    name: z.string(),
    osVersion: z.string(),
    actions: z.array(z.enum(['files', 'shell', 'desktop', 'browser', 'audio', 'apps'])),
  }).optional(),
});
export type MacStatus = z.infer<typeof macStatusSchema>;

/** An app the owner let agents use on their Mac for good ("Always allow"). `app` is the key the approval card named: a bundle id or an exact app name, lowercased. */
export const macAppAccessSchema = z.object({
  app: z.string().min(1),
  /** How the owner reads it ("Notes"), as the card showed it. */
  name: z.string().min(1),
  allowedAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema.optional(),
});
export type MacAppAccess = z.infer<typeof macAppAccessSchema>;

/** `GET /v1/mac/apps`: the apps allowed for good. `DELETE /v1/mac/apps/:app` takes one back (the next use asks again). */
export const macAppsResponseSchema = z.object({ apps: z.array(macAppAccessSchema) });
export type MacAppsResponse = z.infer<typeof macAppsResponseSchema>;

/** Answer to pairing a Mac: shown once to the desktop app, which keeps the token in the macOS Keychain. */
export const macPairingSchema = z.object({
  id: z.string().min(1),
  /** The computer-link address the Mac dials. */
  url: z.string().min(1),
  token: z.string().min(1),
  name: z.string().min(1),
  pairedAt: isoDateTimeSchema,
});
export type MacPairing = z.infer<typeof macPairingSchema>;

/**
 * Where an agent's sandbox runs on this install, and whether its image is ready (`GET /v1/computers/runtime`). `apple-container`
 * and `docker` are the desktop app's local runtimes (Apple `container` is preferred), `cloud` is a server's sandbox, `none` means
 * there is no sandbox: agents then have only the Mac, and `installHint` tells the user how to get one.
 */
export const computerRuntimeSchema = z.object({
  kind: z.enum(['apple-container', 'docker', 'cloud', 'none']),
  image: z.object({
    state: z.enum(['ready', 'missing', 'pulling']),
    /** 0..1 while `pulling`, when the runtime reports it. */
    progress: z.number().min(0).max(1).optional(),
  }),
  installHint: z.string().optional(),
});
export type ComputerRuntime = z.infer<typeof computerRuntimeSchema>;
