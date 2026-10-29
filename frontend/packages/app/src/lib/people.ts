import type { AccountUser } from "../auth/AuthContext";

/** Neutral id used when a decision has no authenticated owner and carries no `by` yet. */
export const UNKNOWN_MEMBER_ID = "unknown";

/**
 * Resolve a member display name. Account consumers supply the authenticated owner; the client
 * exposes member ids on requests and decisions but no member endpoint (yet), so an unknown peer
 * keeps its stable id until a members endpoint supplies a display name.
 */
export function memberName(id: string | undefined, owner?: AccountUser): string {
  if (!id) return "Unknown";
  return owner !== undefined && id === owner.id ? owner.name : id;
}

/** True when the id belongs to the signed-in owner (used for "You" phrasing). Without an owner there is no self. */
export function isSelf(id: string | undefined, owner?: AccountUser): boolean {
  return owner !== undefined && id === owner.id;
}

/** Legacy shared-token mode authenticates no person; this is the honest neutral identity. */
export const TOKEN_USER: AccountUser = {
  id: "token-session",
  name: "Token session",
  email: "",
  initials: "T",
};

/** Neutral identity when no AuthContext is present (standalone component renders). */
export const UNKNOWN_USER: AccountUser = {
  id: "unknown",
  name: "Unknown",
  email: "",
  initials: "?",
};
