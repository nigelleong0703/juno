/**
 * The session protocol behind `juno serve` (PROTOCOL.md): JSON lines in, JSON lines out, one Juno client per
 * process. A request `{id, method, params}` gets one response `{id, result}` or `{id, error}`. Events of a chat
 * turn arrive as notifications `{method: 'event', params: {turn, event}}` until the turn's `done`. Requests are
 * handled in the order they arrive; a turn runs in the background, so a send returns at once.
 */
import type { Chat } from './chat.js';
import { JunoError } from './errors.js';
import { createJuno } from './juno.js';
import type { ApprovalDecision, ChatEvent, ChatTarget, Juno } from './types.js';

/** The protocol version this build speaks. Bumped only for a change a client has to notice. */
export const PROTOCOL_VERSION = 1;

/** The stdio side of a session: request lines in, protocol lines out. */
export interface ServeIo {
  /** One line per request; the iterable ends when the input closes. */
  readonly input: AsyncIterable<string>;
  /** Writes one protocol line. The caller adds the newline. */
  write(line: string): void;
}

/** The server a session talks to. `fetch` is for tests. */
export interface ServeTarget {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

interface Envelope {
  id: string | number;
  method: string;
  params: unknown;
}

interface EventParams {
  turn: string;
  event: ChatEvent;
}

/** Runs one session until `shutdown` or the end of the input. */
export async function serve(io: ServeIo, target: ServeTarget): Promise<void> {
  const session = new Session(io, target);
  try {
    for await (const line of io.input) {
      if (!(await session.handleLine(line))) return;
    }
  } finally {
    await session.close();
  }
}

class Session {
  private readonly juno: Juno;
  /** Open chats by chat id (the conversation id). */
  private readonly chats = new Map<string, Chat>();
  /** The chat that yielded each pending request, so `chat.resolve` can answer it. */
  private readonly requestChats = new Map<string, Chat>();
  /** Turn consumers start once their send response is written, so a turn's events never precede it. */
  private startAfterResponse: Array<() => void> = [];
  private initialized = false;
  private closed = false;
  private turns = 0;

  constructor(
    private readonly io: ServeIo,
    private readonly target: ServeTarget,
  ) {
    this.juno = createJuno({
      baseUrl: target.baseUrl,
      token: target.token,
      ...(target.fetch ? { fetch: target.fetch } : {}),
    });
  }

  /** Handles one input line. Returns false when the session must end (after `shutdown`). */
  async handleLine(line: string): Promise<boolean> {
    if (line.trim() === '') return true;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ id: null, error: { code: 'PARSE_ERROR', message: 'The line is not valid JSON' } });
      return true;
    }
    const envelope = readEnvelope(message);
    if (envelope === null) {
      this.write({
        id: idOf(message),
        error: { code: 'INVALID_REQUEST', message: 'A request needs "id" (string or number) and "method" (string)' },
      });
      return true;
    }

    try {
      const result = await this.dispatch(envelope.method, envelope.params);
      this.write({ id: envelope.id, result });
    } catch (error) {
      this.write({ id: envelope.id, error: errorBody(error) });
    }
    const starts = this.startAfterResponse;
    this.startAfterResponse = [];
    for (const start of starts) start();

    return envelope.method !== 'shutdown';
  }

  /** Ends the session: no more lines are written, and open turns end with CLOSED (not reported). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.juno.close();
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') return this.initialize(params);
    if (method === 'shutdown') return {};
    if (!this.initialized) throw new JunoError('NOT_INITIALIZED', 'Send "initialize" before any other method');
    switch (method) {
      case 'chat.open':
        return this.openChat(params);
      case 'chat.send':
        return this.sendMessage(params);
      case 'chat.resolve':
        return this.resolveRequest(params);
      case 'chat.stop':
        return this.stopChat(params);
      default:
        throw new JunoError('METHOD_NOT_FOUND', `Unknown method "${method}"`);
    }
  }

  private initialize(params: unknown): unknown {
    const version = isRecord(params) ? params.protocolVersion : undefined;
    if (typeof version !== 'number') throw new JunoError('INVALID_PARAMS', '"protocolVersion" must be a number');
    if (version !== PROTOCOL_VERSION) {
      throw new JunoError('UNSUPPORTED_VERSION', `This juno speaks protocol ${PROTOCOL_VERSION}, the client asked for ${version}`);
    }
    this.initialized = true;
    return { protocolVersion: PROTOCOL_VERSION, server: { baseUrl: this.target.baseUrl } };
  }

  private async openChat(params: unknown): Promise<unknown> {
    const chat = await this.juno.chat(chatTarget(params));
    // The chat id is the conversation id. Opening the same conversation again keeps the first Chat, which
    // holds the turn `chat.stop` acts on.
    if (!this.chats.has(chat.id)) this.chats.set(chat.id, chat);
    return { chatId: chat.id };
  }

  private sendMessage(params: unknown): unknown {
    const chat = this.chatOf(params);
    const text = requiredString(params, 'text');
    this.turns += 1;
    const turn = `turn-${this.turns}`;
    const events = chat.send(text);
    this.startAfterResponse.push(() => void this.consume(turn, chat, events));
    return { turnId: turn };
  }

  private async resolveRequest(params: unknown): Promise<unknown> {
    const requestId = requiredString(params, 'requestId');
    const decision = isRecord(params) ? params.decision : undefined;
    if (!isRecord(decision)) throw new JunoError('INVALID_PARAMS', '"decision" must be an object, for example {"action":"approve"}');
    const chat = this.requestChats.get(requestId);
    if (!chat) throw new JunoError('UNKNOWN_REQUEST', `Request ${requestId} is not pending on a turn of this session`);
    const request = await chat.resolve(requestId, decision as ApprovalDecision);
    this.requestChats.delete(requestId);
    return request;
  }

  private async stopChat(params: unknown): Promise<unknown> {
    const run = await this.chatOf(params).stop();
    return { run };
  }

  /** Pulls one turn's events and writes them as notifications. A failure ends the turn with `turn.failed`. */
  private async consume(turn: string, chat: Chat, events: AsyncGenerator<ChatEvent>): Promise<void> {
    try {
      for await (const event of events) {
        if (event.type === 'request') this.requestChats.set(event.request.id, chat);
        const params: EventParams = { turn, event };
        this.write({ method: 'event', params });
      }
    } catch (error) {
      this.write({ method: 'turn.failed', params: { turn, error: errorBody(error) } });
    }
  }

  private chatOf(params: unknown): Chat {
    const chatId = requiredString(params, 'chatId');
    const chat = this.chats.get(chatId);
    if (!chat) throw new JunoError('UNKNOWN_CHAT', `No open chat ${chatId}; call "chat.open" first`);
    return chat;
  }

  private write(message: object): void {
    if (!this.closed) this.io.write(JSON.stringify(message));
  }
}

function chatTarget(params: unknown): ChatTarget {
  const agentId = optionalString(params, 'agentId');
  const conversationId = optionalString(params, 'conversationId');
  if (agentId !== undefined && conversationId === undefined) return { agentId };
  if (conversationId !== undefined && agentId === undefined) return { conversationId };
  throw new JunoError('INVALID_PARAMS', 'Give exactly one of "agentId" or "conversationId"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvelope(message: unknown): Envelope | null {
  if (!isRecord(message)) return null;
  const { id, method } = message;
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof method !== 'string') return null;
  return { id, method, params: message.params };
}

function idOf(message: unknown): string | number | null {
  if (!isRecord(message)) return null;
  const { id } = message;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function optionalString(params: unknown, name: string): string | undefined {
  const value = isRecord(params) ? params[name] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw new JunoError('INVALID_PARAMS', `"${name}" must be a non-empty string`);
  return value;
}

function requiredString(params: unknown, name: string): string {
  const value = optionalString(params, name);
  if (value === undefined) throw new JunoError('INVALID_PARAMS', `"${name}" is required`);
  return value;
}

function errorBody(error: unknown): { code: string; message: string; status?: number } {
  if (error instanceof JunoError) {
    return { code: error.code, message: error.message, ...(error.status !== undefined ? { status: error.status } : {}) };
  }
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Unexpected error' };
}
