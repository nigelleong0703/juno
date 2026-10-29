/**
 * What a replayed assistant turn may carry. Plain-text thinking is never replayed: when the stored
 * turn came from another model/api, pi-ai turns its thinking block into a text block and glues it
 * into the assistant `content` (the model then reads its predecessor's thoughts as its own words),
 * and on the same model a plain `reasoning` field is only a re-billed copy. Only an opaque,
 * server-issued reasoning item (Responses `thinkingSignature` JSON) from the very same
 * provider/api/model may be replayed, and only when the caller says the wire accepts it.
 */
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';

export interface ReplayIdentity {
  api: string;
  provider: string;
  model: string;
}

function sameIdentity(message: AssistantMessage, identity: ReplayIdentity): boolean {
  return message.api === identity.api && message.provider === identity.provider && message.model === identity.model;
}

/** A Responses reasoning item serialized by pi-ai into `thinkingSignature`. */
function isReasoningItem(signature: string | undefined): boolean {
  if (signature === undefined || !signature.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(signature);
    return typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'type') === 'reasoning';
  } catch {
    return false;
  }
}

export interface ReplayKeep {
  /** Keep Responses reasoning items (opaque, encrypted) produced by the same provider/api/model. */
  reasoningItems: boolean;
  /** Keep thinking the same model produced in a dedicated wire field (DeepSeek's `reasoning_content` rule); it is never written into content. */
  wireReasoningField: boolean;
  /** Keep signed (and redacted) thinking blocks the same Anthropic model produced; required while extended thinking is on. */
  signedThinking?: boolean;
}

/**
 * Drop thinking from every replayed assistant message, except what `keep` allows from a turn that
 * `identity` itself produced. Redacted blocks go too, except signed Anthropic blocks kept for thinking.
 */
export function stripReplayedThinking(messages: Message[], identity: ReplayIdentity, keep: ReplayKeep): Message[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    const own = sameIdentity(message, identity);
    const content = message.content.filter((block) => {
      if (block.type !== 'thinking') return true;
      if (!own) return false;
      if (keep.signedThinking === true && block.thinkingSignature !== undefined && block.thinkingSignature.length > 0) return true;
      if (block.redacted) return false;
      return (keep.reasoningItems && isReasoningItem(block.thinkingSignature)) || (keep.wireReasoningField && block.thinkingSignature === 'reasoning_content');
    });
    return content.length === message.content.length ? message : { ...message, content };
  });
}
