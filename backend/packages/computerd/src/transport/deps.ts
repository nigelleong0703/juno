/** Shared dependency and helper types for computerd's route modules. */
import type { Hono, Context } from 'hono';
import type { ComputerProvider } from '@agent-desktop/sandbox-adapters';
import type { Lifecycle } from '../modules/computers/lifecycle.js';
import type { MacComputer } from '../modules/mac/mac-computer.js';

export interface ComputerdDeps {
  lifecycle: Lifecycle;
  provider: ComputerProvider;
  token: string;
  /** Whether the bearer token is required (always true outside tests). */
  requireAuth: boolean;
  /** The owner's Mac (My Mac), for a call the runner marks `x-computer: mac`. */
  mac?: MacComputer;
}

export type RouteApp = Hono;
export type RouteContext = Context;

