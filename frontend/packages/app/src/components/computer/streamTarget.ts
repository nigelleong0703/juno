import type { ScreenStreamTicket } from "@agent-desktop/client";
import type { LiveScreenTarget } from "./types";

/** `?screen=novnc` (or localStorage `juno.screenPlayer = "novnc"`) forces the noVNC player, for comparison. */
export const FORCE_NOVNC_PARAM = "screen";
export const PLAYER_STORAGE_KEY = "juno.screenPlayer";

export function isNoVncForced(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get(FORCE_NOVNC_PARAM) === "novnc") return true;
    return window.localStorage.getItem(PLAYER_STORAGE_KEY) === "novnc";
  } catch {
    return false;
  }
}

/**
 * The player target for a stream ticket. The adapter follows the contract: a ticket with `voxlUrl`
 * is shown by voxl; without it (or when noVNC is forced) the websocket `url` goes to noVNC exactly
 * as before. `control` is the mode the ticket was requested for.
 */
export function screenTargetFromTicket(
  ticket: ScreenStreamTicket,
  control: boolean,
  forceNoVnc: boolean = isNoVncForced(),
): LiveScreenTarget {
  return !forceNoVnc && ticket.voxlUrl
    ? { url: ticket.url, voxlUrl: ticket.voxlUrl, control }
    : { url: ticket.url };
}
