import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { inject } from 'vitest';

/**
 * A stand-in for Slack's Web API on the port the stack's SLACK_API_BASE_URL names (stack.ts), the same kind of stand-in as the Composio
 * one. agentd talks to it exactly like to Slack: it posts replies (`chat.postMessage`, in a thread when `thread_ts` is set), reacts
 * (`reactions.add` / `reactions.remove`), names the channel and the people, and reads the channel's history and threads. The channel's
 * messages are kept here, humans' (put in by `say`, which is what the events webhook of a real workspace would also deliver) and the
 * agent's (posted through the API), so what the agent reads as history is what was said.
 *
 * Time is the scenario clock (harness/clock.mjs): message `ts` values are scenario time, so a "week" of messages reads as a week.
 */

export interface SlackUser { id: string; name: string }

export interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  user: string;
  text: string;
  /** Posted by the app (the agent), with the name it was posted under. */
  bot?: { username: string };
}

export interface SlackReaction { channel: string; ts: string; name: string; op: 'add' | 'remove'; at: number }

export const BOT_USER = 'UBOTNOVA';
export const SLACK_PEOPLE: Record<string, SlackUser> = {
  owner: { id: 'U0ROBIN', name: 'Robin' },
  alice: { id: 'U0ALICE', name: 'Alice' },
  bob: { id: 'U0BOB', name: 'Bob' },
  carol: { id: 'U0CAROL', name: 'Carol' },
};

/** Scenario time now, in milliseconds: real time plus the clock file's offset (what agentd reads as now). */
export function scenarioNow(): number {
  try {
    return Date.now() + (Number(readFileSync(inject('e2e').clockFile, 'utf8')) || 0);
  } catch {
    return Date.now();
  }
}

export class FakeSlack {
  readonly messages: SlackMessage[] = [];
  readonly reactions: SlackReaction[] = [];
  readonly channelNames = new Map<string, string>();
  /** How the next `chat.postMessage` calls fail, one entry per call (outbox scenario); once empty, posts succeed. */
  readonly failures: Array<{ status: number; body?: Record<string, unknown> }> = [];
  /** Every `chat.postMessage` call in order, whether it failed or not. */
  readonly attempts: Array<{ channel: string; text: string; status: number }> = [];
  /** The calls that change nothing in the channel (assistant status and prompts, home views, opened DMs), as agentd made them. */
  readonly calls: Array<{ method: string; body: Record<string, string> }> = [];
  private server: Server | undefined;
  private port = 0;
  private readonly uploads = new Map<string, string>();
  private lastMicros = 0;

  /** A fresh Slack timestamp (`seconds.micros`), strictly increasing, in scenario time. */
  nextTs(): string {
    const micros = Math.max(this.lastMicros + 1, scenarioNow() * 1000);
    this.lastMicros = micros;
    return String(Math.floor(micros / 1_000_000)) + '.' + String(micros % 1_000_000).padStart(6, '0');
  }

  /** A human message lands in the channel (the events webhook delivers it to the app separately). */
  record(message: Omit<SlackMessage, 'ts'> & { ts?: string }): SlackMessage {
    const stored: SlackMessage = { ...message, ts: message.ts ?? this.nextTs() };
    this.messages.push(stored);
    return stored;
  }

  /** The agent's own posts in channels, oldest first (its direct messages to the owner are `directPosts`). */
  botPosts(): SlackMessage[] {
    return this.messages.filter((message) => message.bot !== undefined && !message.channel.startsWith('D'));
  }

  /** The agent's posts in direct chats (an approval card for the owner), oldest first. */
  directPosts(): SlackMessage[] {
    return this.messages.filter((message) => message.bot !== undefined && message.channel.startsWith('D'));
  }

  async listen(port: number): Promise<void> {
    this.port = port;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = url.pathname.replace(/^\/api\//, '');
        // The bytes of an upload (the URL files.getUploadURLExternal gave) are taken and not looked at.
        if (url.pathname.startsWith('/upload/')) {
          res.writeHead(200);
          res.end('ok');
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, string> = Object.fromEntries(url.searchParams);
        if (raw.trim().startsWith('{')) body = { ...body, ...(JSON.parse(raw) as Record<string, string>) };
        else if (raw !== '') body = { ...body, ...Object.fromEntries(new URLSearchParams(raw)) };
        if (method === 'chat.postMessage') {
          // A scenario can make the next posts fail (a 503, a Slack error code on a 200); every attempt is recorded, failed or not.
          const failure = this.failures.shift();
          this.attempts.push({ channel: body['channel'] ?? '', text: body['text'] ?? '', status: failure?.status ?? 200 });
          if (failure !== undefined) {
            res.writeHead(failure.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(failure.body ?? {}));
            return;
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.handle(method, body)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }

  private thread(channel: string, ts: string): SlackMessage[] {
    return this.messages.filter((message) => message.channel === channel && (message.ts === ts || message.threadTs === ts));
  }

  private shape(message: SlackMessage): Record<string, unknown> {
    return {
      type: 'message', ts: message.ts, text: message.text, user: message.user,
      ...(message.threadTs === undefined ? {} : { thread_ts: message.threadTs }),
      ...(message.bot === undefined ? {} : { bot_id: 'B0NOVA', username: message.bot.username }),
    };
  }

  private handle(method: string, body: Record<string, string>): Record<string, unknown> {
    const channel = body['channel'] ?? '';
    switch (method) {
      case 'chat.postMessage': {
        const posted = this.record({ channel, user: BOT_USER, text: body['text'] ?? '', ...(body['thread_ts'] === undefined ? {} : { threadTs: body['thread_ts'] }), bot: { username: body['username'] ?? 'Nova' } });
        return { ok: true, channel, ts: posted.ts };
      }
      case 'reactions.add':
      case 'reactions.remove':
        this.reactions.push({ channel, ts: body['timestamp'] ?? '', name: body['name'] ?? '', op: method === 'reactions.add' ? 'add' : 'remove', at: scenarioNow() });
        return { ok: true };
      case 'conversations.info':
        return { ok: true, channel: { id: channel, name: this.channelNames.get(channel) ?? 'team-ops', is_ext_shared: false } };
      case 'conversations.history': {
        const latest = body['latest'] === undefined ? Infinity : Number(body['latest']);
        const limit = Number(body['limit'] ?? 30);
        const top = this.messages.filter((message) => message.channel === channel && message.threadTs === undefined && Number(message.ts) < latest);
        return { ok: true, messages: top.slice(-limit).reverse().map((message) => this.shape(message)) };
      }
      case 'conversations.replies': {
        const latest = body['latest'] === undefined ? Infinity : Number(body['latest']);
        return { ok: true, messages: this.thread(channel, body['ts'] ?? '').filter((message) => Number(message.ts) <= latest).map((message) => this.shape(message)) };
      }
      case 'users.info': {
        const person = Object.values(SLACK_PEOPLE).find((candidate) => candidate.id === body['user']);
        return person === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user: { id: person.id, real_name: person.name, profile: { display_name: person.name } } };
      }
      case 'files.getUploadURLExternal': {
        const id = 'F0' + String(this.uploads.size + 1);
        this.uploads.set(id, body['filename'] ?? 'file');
        return { ok: true, upload_url: `http://127.0.0.1:${String(this.port)}/upload/${id}`, file_id: id };
      }
      case 'files.completeUploadExternal': {
        // The files land in the channel (the thread when it names one) as a post of the agent's, so the channel reads what was shared.
        const files = (body['files'] as unknown as Array<{ id: string; title?: string }> | undefined) ?? [];
        const names = files.map((file) => file.title ?? this.uploads.get(file.id) ?? file.id).join(', ');
        const channelId = body['channel_id'] ?? channel;
        this.record({ channel: channelId, user: BOT_USER, text: `[file shared: ${names}]${body['initial_comment'] === undefined ? '' : ' ' + body['initial_comment']}`, ...(body['thread_ts'] === undefined ? {} : { threadTs: body['thread_ts'] }), bot: { username: 'Nova' } });
        return { ok: true };
      }
      case 'assistant.threads.setStatus':
      case 'assistant.threads.setSuggestedPrompts':
      case 'views.publish':
        this.calls.push({ method, body });
        return { ok: true };
      case 'conversations.open':
        this.calls.push({ method, body });
        return { ok: true, channel: { id: 'D0OWNER' } };
      default:
        return { ok: false, error: 'not_supported_by_the_stand_in' };
    }
  }
}
