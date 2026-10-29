/**
 * Which apps on the owner's Mac agents may use without asking (BACKEND §7.12). "Always allow" on the "<Agent> wants to use <App>
 * on your Mac" card keeps one `app` rule (`subject: mac:<key>`, behavior `auto`) per app for the owner, any agent. The key is the
 * app as the card named it (a bundle id or an exact app name), lowercased: the Mac resolves the same text, so an approval for
 * "notes" cannot reach another app. The rules live in the ordinary `rules` collection, so the store already scopes them to the owner.
 */
import { createHash } from 'node:crypto';
import type { Rule } from '@agent-desktop/public-contracts';
import type { Store } from '../contracts/index.js';

const PREFIX = 'mac:';
const SUFFIX = ' on your Mac';

/** The approval key of an app argument: trimmed, one space between words, lowercase. */
export function macAppKey(app: string): string {
  return app.trim().replace(/\s+/g, ' ').toLowerCase();
}

export const macAppRuleId = (key: string): string => 'rul-macapp-' + createHash('sha256').update(key).digest('hex').slice(0, 24);

const isMacAppRule = (rule: Rule): boolean => rule.scope === 'app' && rule.behavior === 'auto' && (rule.subject ?? '').startsWith(PREFIX);

/** Whether the owner already allowed this app for good (`rules` is the policy config's rule list). */
export function macAppAllowed(rules: readonly Rule[], app: string): boolean {
  const subject = PREFIX + macAppKey(app);
  return rules.some((rule) => rule.enabled && isMacAppRule(rule) && rule.subject === subject);
}

/** "Always allow": idempotent, so a second approval of the same app changes nothing. */
export async function allowMacApp(store: Store, ownerId: string, app: string, name: string): Promise<void> {
  const key = macAppKey(app);
  const id = macAppRuleId(key);
  if ((await store.get('rules', id)) !== null) return;
  await store.put('rules', {
    id,
    description: `Use ${name.slice(0, 80)}${SUFFIX}`,
    scope: 'app',
    behavior: 'auto',
    source: 'user',
    enabled: true,
    subject: PREFIX + key,
    createdAt: new Date().toISOString(),
    createdBy: ownerId,
  });
}

/** The use of an allowed app is remembered (best effort) so the owner can see which ones are alive. */
export async function noteMacAppUsed(store: Store, app: string): Promise<void> {
  const id = macAppRuleId(macAppKey(app));
  if ((await store.get('rules', id)) !== null) await store.patch('rules', id, { lastUsedAt: new Date().toISOString() });
}

export interface MacAppAccess {
  app: string;
  name: string;
  allowedAt: string;
  lastUsedAt?: string;
}

export async function listMacApps(store: Store): Promise<MacAppAccess[]> {
  const found: Rule[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list('rules', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.items.filter(isMacAppRule));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((rule) => ({
      app: (rule.subject ?? '').slice(PREFIX.length),
      name: rule.description.replace(/^Use /, '').replace(new RegExp(`${SUFFIX}$`), ''),
      allowedAt: rule.createdAt,
      ...(rule.lastUsedAt === undefined ? {} : { lastUsedAt: rule.lastUsedAt }),
    }));
}

/** Take one back; false when it was not allowed. */
export async function revokeMacApp(store: Store, app: string): Promise<boolean> {
  const id = macAppRuleId(macAppKey(app));
  const rule = await store.get('rules', id);
  if (rule === null || !isMacAppRule(rule)) return false;
  await store.delete('rules', id);
  return true;
}
