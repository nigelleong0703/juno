// Proxy mode: a hidden tool is run through `tool_call {name, arguments}`. The unwrap happens once, where the model's reply is
// received, so everything after it (policy, approval, step labels, the opening line, parallel runs) sees the real tool and its
// own arguments, exactly as for a tool the model called directly. `wireName` keeps what the model actually called; the stored
// assistant message keeps the raw `tool_call` block, so replay is unchanged.
import type { AssistantTurn } from '../../contracts/index.js';
import { parseToolCall, TOOL_CALL } from '../../modules/tools/tools/toolSearch.js';

type Call = AssistantTurn['toolCalls'][number];

/** The calls with every well-formed `tool_call` replaced by the tool it names; a malformed one stays and fails its own schema. */
export function unwrapProxyCalls(calls: readonly Call[]): Call[] {
  return calls.map((call) => {
    if (call.name !== TOOL_CALL) return call;
    const inner = parseToolCall(call.arguments);
    return inner === null ? call : { id: call.id, name: inner.name, arguments: inner.arguments, wireName: TOOL_CALL };
  });
}
