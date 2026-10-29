/** computerd's environment, parsed once. Separate from the backend config so the service can boot alone. */
import { z } from 'zod';
import { DEFAULT_SCREEN_RESOLUTION } from '@agent-desktop/contracts';
import { computerStorage } from './storage.js';

export const computerConfigSchema = z.object({
  /** Pre-account owner whose computer state lives in the unscoped files; empty disables that legacy path. */
  OWNER_ID: z.string().default(''),
  COMPUTERD_PORT: z.coerce.number().int().default(8791),
  /**
   * The computer link (BACKEND §7.11): every computer's `juno-link` dials this endpoint (path /v1/computer-link), so it must be
   * reachable from the computers, not from users. Its own listener keeps the main API on loopback.
   * Loopback unless set: Docker Desktop reaches it through `host.docker.internal`; a server whose computers sit on another network
   * (E2B, Docker on Linux) sets the address they can reach (`0.0.0.0`, or the private-network IP).
   */
  COMPUTERD_LINK_PORT: z.coerce.number().int().default(8795),
  COMPUTERD_LINK_HOST: z.string().default('127.0.0.1'),
  /** What a new computer dials. Empty: `ws://host.docker.internal:<COMPUTERD_LINK_PORT>/v1/computer-link` for local Docker; E2B and others must set it (wss://). */
  COMPUTERD_LINK_URL: z.string().default(''),
  /** What a user's Mac dials to join as a computer (My Mac). Empty: COMPUTERD_LINK_URL when set, else `ws://localhost:<COMPUTERD_LINK_PORT>/v1/computer-link` (a Mac on the same machine as the dev backend). */
  COMPUTERD_MAC_LINK_URL: z.string().default(''),
  /** Bearer the runner's client and agentd's proxy send. */
  COMPUTERD_TOKEN: z.string().default(''),
  /** HMAC key for the short-lived per-screen stream tickets. */
  SCREEN_TICKET_SECRET: z.string().default(''),
  /** JSON file the agent→display pool is persisted to; empty keeps the pool in memory. */
  SCREEN_REGISTRY_FILE: z.string().default(''),
  COMPUTER_PROVIDER: z.enum(['e2b', 'fake', 'local']).default('e2b'),
  E2B_API_KEY: z.string().default(''),
  /** E2B control-plane API. The self-hosted server needs BOTH this and E2B_SANDBOX_URL, or the SDK falls back to E2B cloud. */
  E2B_API_URL: z.string().default(''),
  E2B_SANDBOX_URL: z.string().default(''),
  /** Existing sandbox to bind to instead of creating a new one (development reuse). */
  E2B_SANDBOX_ID: z.string().default(''),
  E2B_TEMPLATE: z.string().default('desktop-debian'),
  /** Local Docker image for COMPUTER_PROVIDER=local; built and verified separately. */
  LOCAL_SANDBOX_IMAGE: z.string().default('juno-desktop:local'),
  COMPUTER_RESOLUTION: z.string().default(DEFAULT_SCREEN_RESOLUTION),
  /** IANA timezone for the agent screens (the start page clock, sites, apps). No per-user setting yet. */
  COMPUTER_TIMEZONE: z.string().regex(/^[A-Za-z0-9_+\-/]+$/, 'COMPUTER_TIMEZONE must be an IANA name like Asia/Singapore').default('UTC'),
  /** Sandbox TTL. The self-hosted server caps this at 1h; it is refreshed on every attach. */
  COMPUTER_TIMEOUT_MS: z.coerce.number().int().default(60 * 60 * 1000),
  COMPUTER_IDLE_PAUSE_MINUTES: z.coerce.number().int().default(30),
  /** Unset: 2 GB (E2B) or 4 GB (local Docker, see `computerSize`). */
  COMPUTER_RAM_GB: z.coerce.number().optional(),
  /** Unset: 2 vCPU. */
  COMPUTER_VCPU: z.coerce.number().int().optional(),
  /**
   * Where /juno and /workspace live (BACKEND 7.10). Unset: `local-volume` for COMPUTER_PROVIDER=local, `none` otherwise
   * (files stay on the computer's own disk). `juicefs` needs the STORAGE_* fields below.
   */
  COMPUTER_STORAGE: z.enum(['none', 'local-volume', 'juicefs']).optional(),
  /** JuiceFS metadata engine. Postgres: one schema per user is created in this database, so give it its own database, not the app's. */
  STORAGE_META_URL: z.string().default(''),
  /** JuiceFS object storage: `s3` (AWS S3, R2, MinIO; the default) or `file` (a local directory, tests only). */
  STORAGE_TYPE: z.enum(['s3', 'file']).default('s3'),
  /** S3 API endpoint, e.g. https://<account>.r2.cloudflarestorage.com. For STORAGE_TYPE=file this is unused. */
  STORAGE_S3_ENDPOINT: z.string().default(''),
  /** Bucket name (a directory path for STORAGE_TYPE=file). Every user's file system gets its own prefix inside it. */
  STORAGE_S3_BUCKET: z.string().default(''),
  STORAGE_S3_ACCESS_KEY: z.string().default(''),
  STORAGE_S3_SECRET_KEY: z.string().default(''),
}).superRefine((config, ctx) => {
  try {
    computerStorage(config);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error), path: ['COMPUTER_STORAGE'] });
  }
});

export type ComputerConfig = z.infer<typeof computerConfigSchema>;

type SizeInput = Pick<ComputerConfig, 'COMPUTER_PROVIDER' | 'COMPUTER_RAM_GB' | 'COMPUTER_VCPU'>;

/** The computer's size: local Docker defaults to 2 vCPU / 4 GB (a laptop), E2B and the rest to 2 vCPU / 2 GB. */
export function computerSize(config: SizeInput): { vcpu: number; ramGb: number } {
  const local = config.COMPUTER_PROVIDER === 'local';
  return { vcpu: config.COMPUTER_VCPU ?? 2, ramGb: config.COMPUTER_RAM_GB ?? (local ? 4 : 2) };
}

export function loadComputerConfig(env: Record<string, string | undefined> = process.env): ComputerConfig {
  return computerConfigSchema.parse(env);
}
