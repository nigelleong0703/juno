/** Titles that carry no role: the backend's default ("New agent") and the agentCreate fallback ("Agent"). */
export const UNSET_ROLES: ReadonlySet<string> = new Set(["", "Agent", "New agent"]);

/** The agent's role for display: `undefined` while its title is blank or one of the placeholders. */
export function agentRole(agent: { title?: string | undefined }): string | undefined {
  const title = (agent.title ?? "").trim();
  return UNSET_ROLES.has(title) ? undefined : title;
}
