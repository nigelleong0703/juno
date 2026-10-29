import type { PhoneCallResult, PhoneDeclaration } from '@agent-desktop/public-contracts';

/**
 * Rows the coordinator writes and execution workers read (BACKEND 2.2c). The coordinator holds the app connections, the
 * iPhone's answers and the Discord gateway; a worker runs the tools that need them, so what they share lives in the
 * database, not in either process's memory.
 */

export type ClientKind = 'ios' | 'android' | 'web' | 'desktop';

/**
 * Where one owner is right now. The coordinator, which holds the event streams, is the only writer: it rewrites the row when a
 * stream opens or closes and every few seconds while any is open (`heartbeatAt`). A row with open clients whose heartbeat is
 * older than the TTL belongs to a coordinator that died, and reads as "no app open".
 */
export interface OwnerPresenceRow {
  /** The owner's id. */
  id: string;
  ownerId: string;
  /** App kinds holding an event stream right now. */
  clients: ClientKind[];
  /** Agents whose screen the owner is watching right now. */
  watching: string[];
  /** When the last stream closed (epoch ms); meaningful while no client is open. */
  lastActiveAt?: number;
  heartbeatAt: number;
  /** What the open iPhone app declared (BACKEND 7.13); gone with its stream. */
  phone?: PhoneDeclaration;
}

/** One call to the iPhone app: the asking worker polls this row, the coordinator writes the app's answer (or `lost`). */
export interface PhoneCallRow {
  id: string;
  ownerId: string;
  status: 'pending' | 'done' | 'lost';
  result?: PhoneCallResult;
  createdAt: string;
}

export type VoiceOp = 'join' | 'leave' | 'transcript';

/** One Discord voice tool call made on a worker: the coordinator that holds the gateway runs it and writes the reply. */
export interface VoiceCallRow {
  id: string;
  ownerId: string;
  op: VoiceOp;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'done';
  reply?: { ok: true; text: string } | { ok: false; error: string };
  createdAt: string;
}
