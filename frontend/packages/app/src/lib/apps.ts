import type { ActionsPolicy, App, AppInstallation, AppProblem } from "@agent-desktop/client";
import { t } from "./i18n";

/** The pills of the Apps page. Work includes the owner's custom servers; Web & video apps add like work apps unless they still need a sign-in. */
export type AppPill = "connected" | "chat" | "work" | "web";

export const APP_PILLS: readonly AppPill[] = ["connected", "chat", "work", "web"];

/** Rows shown before "Show more". */
export const APP_ROWS = 12;

/** The one muted line under an app whose login is not ours: Composio holds it. Null for the other sources. */
export const sourceNote = (app: App): string | null => (app.source === "composio" ? t("apps.loginHeldByComposio") : null);

/** Whether the app has at least one account or workspace. */
export const isAdded = (app: App): boolean => app.installations.length > 0;

/** An installation whose sign-in is rejected (it worked before) or never worked: the row says "Sign in". */
export const needsSignIn = (app: App): boolean => app.installations.some((installation) => installation.status !== "connected");

/** A Web & video app the backend cannot add yet (it still needs a sandbox sign-in). The no-sign-in ones are `available` and add like any app. */
export const isComingSoon = (app: App): boolean => app.category === "web" && !app.available;

export function canAdd(app: App): boolean {
  return app.available && !isComingSoon(app);
}

/** The state a row shows on its right: nothing when all is well. */
export function rowState(app: App): "sign-in" | "coming-soon" | null {
  if (isComingSoon(app) && !isAdded(app)) return "coming-soon";
  if (needsSignIn(app)) return "sign-in";
  return null;
}

/** The first installation that needs signing in, for "Sign in again". */
export const expiredInstallation = (app: App): AppInstallation | undefined => app.installations.find((installation) => installation.status !== "connected");

const inPill = (app: App, pill: AppPill): boolean => {
  if (pill === "connected") return isAdded(app);
  if (pill === "work") return app.category === "work" || app.category === "custom";
  return app.category === pill;
};

/** A search looks across every category; without one the pill decides. */
export function filterApps(apps: readonly App[], pill: AppPill, query: string): App[] {
  const needle = query.trim().toLowerCase();
  if (needle !== "") return apps.filter((app) => `${app.name} ${app.blurb} ${app.description}`.toLowerCase().includes(needle));
  return apps.filter((app) => inPill(app, pill));
}

/** Connected when something is added, else Chat: the pill the page opens on. */
export const defaultPill = (apps: readonly App[]): AppPill => (apps.some(isAdded) ? "connected" : "chat");

/** The banner row: apps that have prompts to try, the ones not added yet first; the first is the lead. */
export function featuredApps(apps: readonly App[], limit = 5): App[] {
  const candidates = apps.filter((app) => app.tryAsking.length > 0 && canAdd(app));
  return [...candidates.filter((app) => !isAdded(app)), ...candidates.filter(isAdded)].slice(0, limit);
}

/** The label under the name on the detail page: "Chat · Connected". */
export function stateLabel(app: App): "connected" | "sign-in" | "not-added" | "coming-soon" {
  if (isComingSoon(app) && !isAdded(app)) return "coming-soon";
  if (!isAdded(app)) return "not-added";
  return needsSignIn(app) ? "sign-in" : "connected";
}

/** Agents that may use a work or custom app (no row = on, so the server lists every agent that is on). */
export const enabledAgentIds = (app: App): string[] => app.enabledAgents.map((entry) => entry.agentId);

export const policyOf = (app: App, agentId: string): ActionsPolicy => app.enabledAgents.find((entry) => entry.agentId === agentId)?.actionsPolicy ?? "ask";

/** The workspaces (installations) of a chat app an agent is enabled in. */
export const workspacesOf = (app: App, agentId: string): AppInstallation[] =>
  app.installations.filter((installation) => installation.agents.some((entry) => entry.agentId === agentId));

/** Why an agent cannot use the app now, worked out from the list (a card from the server states it itself). Null when it can. */
export function appProblem(app: App | undefined, agentId: string): AppProblem | null {
  if (app === undefined || !isAdded(app)) return "not_added";
  if (needsSignIn(app)) return app.installations.some((installation) => installation.status === "expired") ? "expired" : "needs_reconnect";
  if (app.category !== "chat" && !app.enabledAgents.some((entry) => entry.agentId === agentId)) return "not_enabled";
  return null;
}

/** The action a `connect` card offers for one app, by why the app cannot be used. */
export type ConnectAction = "add" | "turn-on" | "reconnect";

/** `needs_reconnect`, `expired` and `scope_missing` are all "sign in again" (`scope_missing` asks for the missing permission on the way). */
export function connectAction(problem: AppProblem | undefined): ConnectAction {
  if (problem === "not_enabled") return "turn-on";
  if (problem === "needs_reconnect" || problem === "expired" || problem === "scope_missing") return "reconnect";
  return "add";
}

/** The `userConfig` values to send, typed per the declared field; an empty optional value is left out. Returns the first problem when a required one is missing. */
export function userConfigValues(
  fields: App["userConfig"],
  draft: Record<string, string | boolean>,
): { values: Record<string, string | number | boolean>; missing: string | null } {
  const values: Record<string, string | number | boolean> = {};
  let missing: string | null = null;
  for (const field of fields) {
    const raw = draft[field.key] ?? field.default ?? (field.type === "boolean" ? false : "");
    if (field.type === "boolean") {
      values[field.key] = raw === true || raw === "true";
      continue;
    }
    const text = String(raw).trim();
    if (text === "") {
      if (field.required && missing === null) missing = field.title;
      continue;
    }
    if (field.type === "number" && Number.isNaN(Number(text))) {
      if (missing === null) missing = field.title;
      continue;
    }
    values[field.key] = field.type === "number" ? Number(text) : text;
  }
  return { values, missing };
}
