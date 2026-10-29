/** How the user writes and how they treat the assistant's own messages, counted by code (BACKEND §5.4): the dream gets numbers, not impressions. */

export interface StatItem {
  id: string;
  conversationId: string;
  at: string;
  role: 'user' | 'agent';
  text: string;
  /** Set on an assistant message the agent started on its own (a routine, a wake), as opposed to an answer. */
  proactive?: boolean;
}

export interface StyleStats {
  userMessages: number;
  chars: { mean: number; median: number; p90: number };
  /** Share of messages up to 40, up to 200, and over 200 characters. */
  lengthShare: { short: number; medium: number; long: number };
  /** Share of letters that are Chinese/Japanese/Korean, and share that are Latin. */
  scriptShare: { cjk: number; latin: number };
  emojiPerMessage: number;
  /** Share of messages that end in sentence punctuation. */
  endsWithPunctuation: number;
  exclamationShare: number;
  /** Share of messages sent right after another of the user's own, with no reply between. */
  burstShare: number;
  proactive: { sent: number; replied: number; ignored: number; pending: number };
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const LATIN = /\p{Script=Latin}/gu;
/** A proactive message younger than this has not had a fair chance to be answered. */
const REPLY_GRACE_MS = 6 * 60 * 60 * 1000;

const share = (count: number, total: number): number => (total === 0 ? 0 : Math.round((count / total) * 1000) / 1000);
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

export function computeStyleStats(items: readonly StatItem[], now: Date): StyleStats {
  const ordered = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const mine = ordered.filter((item) => item.role === 'user');
  const lengths = mine.map((item) => [...item.text].length).sort((a, b) => a - b);
  const at = (q: number): number => lengths[Math.min(lengths.length - 1, Math.floor(q * lengths.length))] ?? 0;
  const letters = mine.reduce((sum, item) => sum + count(item.text, CJK) + count(item.text, LATIN), 0);
  const cjk = mine.reduce((sum, item) => sum + count(item.text, CJK), 0);
  let bursts = 0;
  const proactive = { sent: 0, replied: 0, ignored: 0, pending: 0 };
  const last = new Map<string, StatItem>();
  const open = new Map<string, StatItem[]>();
  for (const item of ordered) {
    const before = last.get(item.conversationId);
    if (item.role === 'user' && before?.role === 'user') bursts += 1;
    if (item.role === 'user') {
      proactive.replied += open.get(item.conversationId)?.length ?? 0;
      open.delete(item.conversationId);
    }
    if (item.role === 'agent' && item.proactive === true) {
      proactive.sent += 1;
      open.set(item.conversationId, [...(open.get(item.conversationId) ?? []), item]);
    }
    last.set(item.conversationId, item);
  }
  for (const item of [...open.values()].flat()) {
    if (now.getTime() - Date.parse(item.at) < REPLY_GRACE_MS) proactive.pending += 1;
    else proactive.ignored += 1;
  }
  return {
    userMessages: mine.length,
    chars: { mean: mine.length === 0 ? 0 : Math.round(lengths.reduce((sum, n) => sum + n, 0) / mine.length), median: at(0.5), p90: at(0.9) },
    lengthShare: {
      short: share(lengths.filter((n) => n <= 40).length, mine.length),
      medium: share(lengths.filter((n) => n > 40 && n <= 200).length, mine.length),
      long: share(lengths.filter((n) => n > 200).length, mine.length),
    },
    scriptShare: { cjk: share(cjk, letters), latin: share(letters - cjk, letters) },
    emojiPerMessage: mine.length === 0 ? 0 : Math.round((mine.reduce((sum, item) => sum + count(item.text, EMOJI), 0) / mine.length) * 100) / 100,
    endsWithPunctuation: share(mine.filter((item) => /[.!?。！？…]$/u.test(item.text.trim())).length, mine.length),
    exclamationShare: share(mine.filter((item) => /[!！]/u.test(item.text)).length, mine.length),
    burstShare: share(bursts, mine.length),
    proactive,
  };
}
