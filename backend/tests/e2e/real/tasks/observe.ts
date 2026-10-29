import type { Observed, ToolCallObs } from './types';

export const callsOf = (o: Observed, ...names: string[]): ToolCallObs[] => o.calls.filter((c) => names.includes(c.name));
export const okResultsOf = (o: Observed, name: string) => o.results.filter((r) => r.toolName === name && !r.isError);
export const lastReply = (o: Observed): string => o.turns.at(-1)?.replies.at(-1) ?? '';
export const allReplies = (o: Observed): string => o.turns.flatMap((t) => t.replies).join('\n---\n');
export const stripTags = (html: string): string => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

/** The skill a shell command or file read touched: `/opt/juno/skills/<name>/...` (SKILL.md or the skill's tool script). */
export function skillsUsed(o: Observed): string[] {
  const found = new Set<string>();
  for (const call of o.calls) {
    const text = JSON.stringify(call.args);
    for (const m of text.matchAll(/\/skills\/([a-z0-9_-]+)\//gi)) if (m[1] !== undefined && !m[1].startsWith('_')) found.add(m[1]);
    for (const m of text.matchAll(/\b([a-z0-9]+)_tool\.py\b/gi)) if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

/** Every URL a browser tool reported, in order; the last one is where the browser ended up. */
export function browserUrls(o: Observed): string[] {
  const urls: string[] = [];
  for (const r of o.results) {
    if (!r.toolName.startsWith('browser.') || r.isError) continue;
    const fromJson = /"url"\s*:\s*"([^"]+)"/.exec(r.text)?.[1];
    const plain = /(?:^|\n)\s*(?:url|URL|page|Page)\s*[:=]\s*(https?:\/\/\S+)/.exec(r.text)?.[1];
    const any = /https?:\/\/[^\s"'<>)\]]+/.exec(r.text)?.[0];
    const url = fromJson ?? plain ?? any;
    if (url !== undefined) urls.push(url);
  }
  for (const s of o.steps) if (s.verb.startsWith('browser') && s.url !== undefined) urls.push(s.url);
  return urls;
}

/** Bookkeeping tools: an error there changes no result, so it is reported but never counts as a workaround. */
const BOOKKEEPING = new Set(['task_update', 'todo_write', 'tasks_list', 'suggest', 'wake_at', 'task_stop']);
const family = (toolName: string): string => toolName.split('.')[0] ?? toolName;

/**
 * Tool errors the agent neither recovered from nor told the user about. Recovery = a later successful call in the same tool family
 * (a stale `browser.click` ref, then a fresh `browser.snapshot` and a working click). A silent workaround = the family never worked
 * again and the final message does not mention the problem (snapshot fails, the agent carries on with screenshots and coordinates).
 */
export function silentErrors(o: Observed): string[] {
  // The person must be told somewhere in the case, not necessarily in the last message: a tool error is reported when it happens and the
  // closing message may only offer the next step. A sign-in the person has to do counts as telling them.
  const told = /\b(error|errors|fail(ed|ure|s)?|couldn'?t|could not|can'?t|cannot|unable|issue|problem|blocked|didn'?t work|not work|timed? out|unavailable|stale|sign[- ]?in|log[- ]?in)\b/i.test(allReplies(o));
  const silent: string[] = [];
  o.results.forEach((r, index) => {
    if (!r.isError || BOOKKEEPING.has(r.toolName)) return;
    const recovered = o.results.slice(index + 1).some((later) => family(later.toolName) === family(r.toolName) && !later.isError);
    if (!recovered && !told) silent.push(`${r.toolName}: ${r.text.slice(0, 120)}`);
  });
  return silent;
}
