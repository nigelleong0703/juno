import type { App, DecisionBrief, DecisionCategory, DecisionPlatform, DelegableCategory, DelegationDraft, DelegationLimits, DelegationPlatform, Request, RequestOutcome, Rule } from "@agent-desktop/client";
import { DELEGABLE_CATEGORIES, isDelegableCategory } from "@agent-desktop/client";
import { formatAgo } from "../../lib/format";
import { t } from "../../lib/i18n";

export { DELEGABLE_CATEGORIES, isDelegableCategory };
export type { DelegableCategory };

export const categoryLabel = (category: DecisionCategory): string => t(`decision.cat.${category}`);
export const outcomeLabel = (outcome: RequestOutcome): string => t(`decision.outcome.${outcome}`);

/** The brief of an approval request, when it carries one (older requests do not). */
export const briefOf = (request: Request): DecisionBrief | undefined => (request.payload.kind === "approval" ? request.payload.brief : undefined);

/** What a request says it is about: the brief's sentence, else the old title. */
export const requestSentence = (request: Request): string => briefOf(request)?.sentence ?? request.title;

/** The categories to show as badges: the primary first, at most `max`. */
export function badgeCategories(brief: DecisionBrief, max = 2): DecisionCategory[] {
  const rest = brief.categories.filter((category) => category !== brief.primary);
  return (brief.primary && brief.categories.includes(brief.primary) ? [brief.primary, ...rest] : rest).slice(0, max);
}

export function formatMoney(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

const moneyOf = (limit: { amount: string; currency: string }) => formatMoney(limit.amount, limit.currency);

/** One consequence of an approval, in words. `declared` = only the agent says so (shown greyed). */
export interface Fact {
  id: string;
  text: string;
  declared: boolean;
}

function whenText(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return `${date.toLocaleDateString("en", { weekday: "short" })} ${date.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })}`;
}

/** The facts of a brief, heaviest first: undoable-ness, money, sensitive data, audience, promises, the account, targets. */
export function factsOf(brief: DecisionBrief): Fact[] {
  const { facts } = brief;
  const out: Fact[] = [];
  const declared = (source: string) => source === "declared";
  if (facts.reversible && facts.reversible.value !== "yes") {
    out.push({ id: "reversible", text: t(facts.reversible.value === "no" ? "decision.fact.irreversible" : "decision.fact.hard"), declared: declared(facts.reversible.source) });
  }
  if (facts.money) {
    const amount = formatMoney(facts.money.amount, facts.money.currency);
    const text = facts.money.recurring ? t(`decision.fact.per${{ weekly: "Week", monthly: "Month", yearly: "Year" }[facts.money.recurring]}`, { amount }) : amount;
    out.push({ id: "money", text, declared: declared(facts.money.source) });
  }
  for (const [index, item] of (facts.sensitive ?? []).entries()) out.push({ id: `sensitive-${index}`, text: item.label, declared: declared(item.source) });
  if (facts.audience) {
    const { audience } = facts;
    const names = audience.recipients.map((recipient) => recipient.address ?? recipient.name);
    const extra = Math.max(0, (audience.count ?? names.length) - 2);
    const shown = names.slice(0, 2).join(", ");
    const text =
      audience.kind === "public"
        ? t("decision.fact.public")
        : names.length === 0
          ? t("decision.fact.room")
          : t("decision.fact.toPeople", { names: extra > 0 ? t("decision.fact.moreNames", { names: shown, count: extra }) : shown });
    out.push({ id: "audience", text, declared: declared(audience.source) });
  }
  for (const [index, item] of (facts.commitments ?? []).entries()) {
    out.push({ id: `commitment-${index}`, text: t("decision.fact.commits", { text: whenText(item.at) ?? item.text }), declared: declared(item.source) });
  }
  if (facts.asAccount) out.push({ id: "account", text: t("decision.fact.asAccount", { label: facts.asAccount.label }), declared: declared(facts.asAccount.source) });
  const targets = facts.targets ?? [];
  if (targets.length > 0) {
    const total = targets.reduce((sum, target) => sum + (target.count ?? 1), 0);
    out.push({ id: "targets", text: targets.length === 1 && total === 1 ? (targets[0]?.label ?? "") : t("decision.fact.items", { count: total }), declared: false });
  }
  return out;
}

/** The one consequence a history row shows. */
export const keyConsequence = (brief: DecisionBrief): string | undefined => factsOf(brief)[0]?.text;

function daysText(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const range = sorted.length > 2 && sorted.every((day, index) => index === 0 || day === (sorted[index - 1] ?? 0) + 1);
  const name = (day: number) => t(`decision.weekday.${day}`);
  if (sorted.length === 7) return t("decision.weekday.all");
  return range ? `${name(sorted[0] ?? 0)}–${name(sorted[sorted.length - 1] ?? 0)}` : sorted.map(name).join(", ");
}

/** Names a chat: the title the server sent, else the conversation's own title (looked up by id), else "a chat". */
export type ChatName = (conversationId: string | undefined, title?: string) => string;

/** A chat as the owner sees it: "#work", or "a chat" when nothing names it. */
export const chatLabel = (title: string | undefined): string => (title?.trim() ? `#${title.trim()}` : t("decision.chat.unnamed"));

/** The names a chat has without a lookup: only the title the server sent. */
const titleOnly: ChatName = (_conversationId, title) => chatLabel(title);

/** Chat names in a sentence: the first two, then "+N". */
function chatList(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? t("decision.fact.moreNames", { names: shown, count: names.length - 2 }) : shown;
}

/** "Always allow files from #work in #general": what a sharing offer asks to be allowed from now on. */
export function sharingOffer(draft: DelegationDraft, chatName: ChatName): string {
  const source = chatName(draft.platform.conversationId, draft.platform.title);
  const targets = (draft.limits.recipients ?? []).map((id) => chatName(id));
  return targets.length > 0 ? t("decision.kind.sharing", { source, targets: chatList(targets) }) : t("decision.kind.sharingFrom", { source });
}

/** The button for "allow from now on": a lone sharing offer says what it allows, any other offer is "Allow this kind…". */
export function allowKindLabel(suggested: readonly DelegationDraft[], chatName: ChatName): string {
  const [only] = suggested;
  return suggested.length === 1 && only?.category === "sharing" ? `${sharingOffer(only, chatName)}…` : t("decision.allowKind");
}

/** "expires Jan 20" (the year only when it is not this one), or undefined when the rule has no end or already ended. */
export function expiresText(rule: Rule, now: number = Date.now()): string | undefined {
  const at = rule.expiresAt ? new Date(rule.expiresAt) : undefined;
  if (!at || Number.isNaN(at.getTime()) || at.getTime() < now) return undefined;
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  return t("decision.sum.expires", { date: at.toLocaleDateString("en", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }) });
}

/** "Up to $50 each, $200/month on Stripe": a delegation's limits in one line. For sharing, `platform` is the source chat's name. */
export function limitsSummary(category: DelegableCategory, limits: DelegationLimits, platform: string, chatName: ChatName = titleOnly): string {
  if (category === "sharing") {
    const targets = (limits.recipients ?? []).map((id) => chatName(id));
    return targets.length > 0 ? t("decision.sum.sharing", { source: platform, targets: chatList(targets) }) : t("decision.sum.sharingFrom", { source: platform });
  }
  const parts: string[] = [];
  if (category === "spending") {
    if (limits.perPurchase && limits.perMonth) parts.push(t("decision.sum.upTo", { each: moneyOf(limits.perPurchase), month: moneyOf(limits.perMonth) }));
    if (limits.allowRecurring) parts.push(t("decision.sum.recurring"));
    if (limits.merchants?.length) parts.push(t("decision.sum.merchants", { merchants: limits.merchants.join(", ") }));
  } else if (category === "speaking") {
    parts.push(t(limits.replyOnly ? "decision.sum.repliesOnly" : "decision.sum.anyMessage"));
    if (limits.recipients?.length) parts.push(t("decision.sum.to", { recipients: limits.recipients.join(", ") }));
    if (limits.maxPerDay) parts.push(t("decision.sum.perDay", { count: limits.maxPerDay }));
  } else if (category === "committing") {
    parts.push(t(limits.acceptOnly ? "decision.sum.acceptOnly" : "decision.sum.anyCommit"));
    if (limits.window) parts.push(t("decision.sum.window", { days: daysText(limits.window.days), start: limits.window.start, end: limits.window.end }));
  } else {
    parts.push(t("decision.sum.publicRoutine"));
    if (limits.maxPerDay) parts.push(t("decision.sum.perDay", { count: limits.maxPerDay }));
  }
  return `${parts.join(", ")} ${t("decision.sum.on", { platform })}`;
}

/** The rule's `platformKey` of a delegation platform: `app:<catalogId>`, `site:<host>`, `chat:<conversationId>` or `juno`. */
export function delegationKey(platform: DelegationPlatform): string {
  if (platform.kind === "juno") return "juno";
  if (platform.kind === "chat") return `chat:${platform.conversationId ?? ""}`;
  return platform.kind === "connector" ? `app:${platform.catalogId ?? ""}` : `site:${platform.host ?? ""}`;
}

/** A delegation's platform as an approval platform (for its icon and name): the connector, the site's host, a chat (named, no icon of its own), or Juno. */
export function platformOfKey(platformKey: string, connectors: readonly Pick<App, "id" | "name">[] | undefined, chatName: ChatName = titleOnly): DecisionPlatform {
  if (platformKey === "juno") return { kind: "juno", name: "Juno" };
  const [kind, id = ""] = platformKey.split(":");
  if (kind === "app") return { kind: "connector", name: connectors?.find((connector) => connector.id === id)?.name ?? id, catalogId: id };
  if (kind === "chat") return { kind: "none", name: chatName(id) };
  return { kind: "site", name: id, host: id };
}

/** "Used 3 times · last 2d ago" for a delegation, or "Expired". */
export function usageLine(rule: Rule, now: number = Date.now()): string {
  if (rule.expiresAt && Date.parse(rule.expiresAt) < now) return t("decision.sum.expired");
  return rule.useCount ? t("decision.sum.used", { count: rule.useCount, ago: formatAgo(rule.lastUsedAt, now) }) : "";
}
