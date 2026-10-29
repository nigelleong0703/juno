/**
 * Computer/sandbox domain shapes (SB1). These are the backend-only additions on top of the
 * frontend `Computer` contract: the persisted E2B binding and the per-agent screen.
 *
 * They live here (not in `packages/client`) because they are domain state: the executor and the
 * HTTP proxy need the raw binding and the VNC secrets, while the frontend only ever sees the
 * redacted `ScreenResponse`.
 */
import { z } from 'zod';

export const e2bBindingSchema = z.object({
  sandboxId: z.string().min(1),
  template: z.string().min(1),
  /** E2B node the sandbox is pinned to (multi-node later). */
  node: z.string().optional(),
  /** The computer link id (BACKEND §7.11): which `juno-link` connection reaches this computer. A binding made before the link has none. */
  linkId: z.string().optional(),
});
export type E2bBinding = z.infer<typeof e2bBindingSchema>;

/** Backend-only fields persisted on the `computers` doc, next to the frontend contract fields. */
export const computerBackendFieldsSchema = z.object({
  e2bSandboxId: z.string().optional(),
  e2bTemplate: z.string().optional(),
  e2bNode: z.string().optional(),
});
export type ComputerBackendFields = z.infer<typeof computerBackendFieldsSchema>;

export const screenStateSchema = z.enum(['starting', 'live', 'asleep', 'error', 'stopped']);
export type ScreenState = z.infer<typeof screenStateSchema>;

export const screenControllerSchema = z.enum(['agent', 'user']);
export type ScreenController = z.infer<typeof screenControllerSchema>;

/**
 * One agent's X display inside the shared sandbox. Stored server-side only: the VNC passwords
 * must never reach the client (the WS proxy fills them in at the RFB auth step).
 */
export const screenDocSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  computerId: z.string().min(1),
  agentId: z.string().min(1),
  /** X display number; `DISPLAY=:${displayNo}`. 1..MAX_SCREENS. */
  displayNo: z.number().int().min(1),
  state: screenStateSchema,
  title: z.string(),
  resolution: z.string(),
  lastUsedAt: z.string(),
  lastVncPort: z.number().int().min(5900),
  lastWebPort: z.number().int().min(6080),
  screenshotRef: z.string().optional(),
});
export type ScreenDoc = z.infer<typeof screenDocSchema>;

/** What the API returns for a screen: the doc fields the client may see, plus who holds it now (from its control row). */
export const screenResponseSchema = screenDocSchema.extend({
  controller: screenControllerSchema,
  controllerSince: z.string().optional(),
  /** Bumped on every change of holder; a stream ticket and a conditional take/return carry it. */
  controlEpoch: z.number().int().min(0),
});
export type ScreenResponse = z.infer<typeof screenResponseSchema>;

export function toScreenResponse(screen: ScreenDoc, control?: Pick<ControlState, 'holder' | 'since' | 'epoch'>): ScreenResponse {
  return {
    ...screen,
    controller: control?.holder === 'user' ? 'user' : 'agent',
    ...(control && control.epoch > 0 ? { controllerSince: control.since } : {}),
    controlEpoch: control?.epoch ?? 0,
  };
}

// --- Control (BACKEND 7.8b): who may act on a surface right now -----------------------------------------------------

/** A thing an agent acts on that a person can take or stop. Chrome is the Mac's browser capability, not its own surface. */
export const surfaceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('screen'), screenId: z.string().min(1) }),
  z.object({ kind: z.literal('mac'), macId: z.string().min(1) }),
]);
export type SurfaceRef = z.infer<typeof surfaceRefSchema>;

/** The `controls` row id of a surface. */
export const surfaceKey = (surface: SurfaceRef): string => (surface.kind === 'screen' ? `screen:${surface.screenId}` : `mac:${surface.macId}`);

export const controlHolderSchema = z.enum(['agent', 'user', 'stopped']);
export type ControlHolder = z.infer<typeof controlHolderSchema>;

/** The browser as it was at a moment: chromium pid and tabs (`tabs` absent when unreadable). Never keystrokes. */
export const surfaceSnapshotSchema = z.object({
  pid: z.string().optional(),
  tabs: z.array(z.object({ tab: z.string(), url: z.string(), title: z.string() })).optional(),
});
export type SurfaceSnapshot = z.infer<typeof surfaceSnapshotSchema>;

/** What the agent is told when control comes back. Page titles are untrusted; `cancelled` is the first line of each command Stop killed, never input text. */
export const handBackSchema = z.object({
  heldMs: z.number().int().min(0),
  changes: z.array(z.string()),
  /** An agent action was refused while the person held it, so a run that stopped waiting should continue. */
  blocked: z.boolean(),
  cancelled: z.array(z.string()).optional(),
});
export type HandBack = z.infer<typeof handBackSchema>;

export const controlStateSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  surface: surfaceRefSchema,
  agentId: z.string().optional(),
  holder: controlHolderSchema,
  /** Starts at 0 (never changed); +1 on every change of holder, written in the same transaction. */
  epoch: z.number().int().min(0),
  since: z.string(),
  reason: z.string().optional(),
  /** The `computer` request the person is serving (a `request_takeover`), when there is one. */
  requestId: z.string().optional(),
  /** An agent action was refused while the person held it. */
  blockedAt: z.string().optional(),
  /** After a hand-back the first mutating screen action must be preceded by a fresh screenshot/snapshot. */
  resumeSnapshotRequired: z.boolean(),
  /** The surface when the person took it (screens only). */
  before: surfaceSnapshotSchema.optional(),
  /** What Stop cancelled (Mac only). */
  cancelled: z.array(z.string()).optional(),
  /** The newest release, for whoever tells the agent (replaced by the next take/stop). */
  handBack: handBackSchema.optional(),
  capabilities: z.object({ take: z.boolean(), stop: z.boolean(), resumeRemote: z.boolean() }),
});
export type ControlState = z.infer<typeof controlStateSchema>;

/** Who flips control. Stop may come from any client; resuming a Mac only from the Mac itself. */
export const controlActorSchema = z.object({
  via: z.enum(['web', 'ios', 'android', 'desktop', 'mac-local', 'extension', 'api']),
  /** The person (member id), for the audit trail. */
  userId: z.string().optional(),
});
export type ControlActor = z.infer<typeof controlActorSchema>;

/** Ports on the sandbox for a display number (BACKEND §7.1). */
export const screenPorts = (displayNo: number) => ({
  /** Read-write x11vnc (only reachable from inside the sandbox). */
  vnc: 5900 + displayNo,
  /** Read-only x11vnc for watchers (\`-viewonly\`). */
  readOnlyVnc: 5990 + displayNo,
  /** Read-write websockify listener. */
  web: 6080 + displayNo,
  /** Read-only websockify listener. */
  readOnlyWeb: 6090 + displayNo,
  cdp: 9222 + displayNo,
});

/** Hard cap on simultaneously live displays (BACKEND §7.1). */
export const MAX_LIVE_SCREENS = 4;
export const FIRST_SCREEN_DISPLAY = 1;
/** Screen size every agent display boots with unless COMPUTER_RESOLUTION says otherwise (BACKEND §7.1). */
export const DEFAULT_SCREEN_RESOLUTION = '1440x900';
