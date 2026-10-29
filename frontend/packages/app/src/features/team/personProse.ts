import type { AccountView, PersonRelationView } from "@agent-desktop/client";
import { channelPlatformName } from "../../components/channel/platforms";
import { t } from "../../lib/i18n";

/** The kinds the server words with a different phrase for each end of the relation. */
const DIRECTED = new Set(["manager_of", "client_of", "works_at", "parent_of"]);
/** The kinds with the same phrase from both ends. */
const SYMMETRIC = new Set(["colleague", "spouse", "sibling", "friend"]);

/**
 * A relation as the phrase of the person's sentence: "Ola's friend", "Ola's manager", "works at Acme". `you` is for the owner's
 * own person, whose sentence is "You are …": the one verb phrase reads "employed by Acme" there.
 */
export function relationPhrase(relation: PersonRelationView, you = false): string {
  const { kind, otherName } = relation;
  if (you && kind === "works_at" && relation.direction === "out") return t("team.rel.works_at.you", { name: otherName });
  if (DIRECTED.has(kind)) return t(`team.rel.${kind}.${relation.direction}`, { name: otherName });
  if (SYMMETRIC.has(kind)) return t(`team.rel.${kind}`, { name: otherName });
  // `other`, or a kind this client has no wording for: the server's own word.
  return t("team.rel.other", { name: otherName, label: relation.kindLabel ?? kind.replaceAll("_", " ") });
}

/** "@AlexH" for a handle, the plain display name when it has spaces ("Mina T"), nothing when the platform showed none. */
export function accountHandle(account: Pick<AccountView, "name">): string | undefined {
  const name = account.name?.trim();
  if (!name) return undefined;
  return /\s/.test(name) ? name : `@${name.replace(/^@/, "")}`;
}

/** "@AlexH on Discord", or "a Discord account" when no name was seen. */
export function accountPhrase(account: Pick<AccountView, "platform" | "name">): string {
  const platform = channelPlatformName(account.platform);
  const handle = accountHandle(account);
  return handle ? t("team.accountOn", { handle, platform }) : t("team.accountUnnamed", { platform });
}

/** "Discord · AlexH": the platform as people know it, then the account. */
export function accountLabel(account: Pick<AccountView, "platform" | "name">): string {
  return [channelPlatformName(account.platform), account.name].filter(Boolean).join(" · ");
}

/** The first letter upper-cased ("works at Acme" starts a sentence). */
export function sentenceCase(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}
