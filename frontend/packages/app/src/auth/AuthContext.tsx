import { t } from "../lib/i18n";
import { createContext, useContext } from "react";
import { UNKNOWN_USER, isSelf, memberName } from "../lib/people";

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  initials: string;
}

export type AuthIdentity =
  | { mode: "account"; user: AccountUser; signOut: () => void }
  | { mode: "token"; user: AccountUser };

/** Absent only in standalone component fixtures; production entries always provide it. */
export const AuthContext = createContext<AuthIdentity | null>(null);
export function useAuthIdentity() {
  return useContext(AuthContext);
}
export function useCurrentUser(): AccountUser {
  return useAuthIdentity()?.user ?? UNKNOWN_USER;
}

/**
 * Owner-aware display helpers. Only an authenticated account has an owner, so peers keep their
 * stable ids elsewhere; there are no built-in member aliases.
 */
export function usePeople() {
  const identity = useAuthIdentity();
  const owner = identity?.mode === "account" ? identity.user : undefined;
  // Token mode (a server with a single API token) has exactly one person: every human-authored message is theirs.
  if (identity?.mode === "token") return { isSelf: (id: string | undefined) => id !== undefined, memberName: () => t("transcript.you") };
  return {
    isSelf: (id: string | undefined) => isSelf(id, owner),
    memberName: (id: string | undefined) => memberName(id, owner),
  };
}
