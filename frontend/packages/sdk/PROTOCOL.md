# juno serve: session protocol

`juno serve` runs a Juno session over stdin and stdout, so a program in any language can drive Juno without
the TypeScript SDK. It is the SDK's own client (`createJuno`, `Chat`) behind a small JSON-lines protocol.
Protocol version: **1**.

```sh
JUNO_BASE_URL=https://juno.example.com JUNO_TOKEN=... juno serve   # from this package: node dist/cli.js serve
```

The server comes from the environment: `JUNO_BASE_URL` and `JUNO_TOKEN`. The flags `--base-url` and `--token` are
accepted too and override the environment. `juno serve --help` lists them.

`examples/protocol_client.py` is a Python client for it.

## Transport

- One JSON object per line, UTF-8, each line ended by `\n`.
- stdin carries requests. stdout carries responses and notifications, and nothing else. Diagnostics go to stderr.
- Requests are handled in the order they arrive. A `chat.send` answers at once and its turn runs in the background.
- The session ends at `shutdown`, or when stdin closes. Open turns end without further notifications.
- Set the token with `JUNO_TOKEN`, not `--token`. A flag value is visible to other local users in the process list on
  some systems. When `--token` is used, `juno serve` prints a warning to stderr saying so.

## Messages

A **request** has an `id` (string or number, unique in the session), a `method` and `params`:

```json
{"id": 3, "method": "chat.send", "params": {"chatId": "cvn-1", "text": "hi"}}
```

A **response** has the same `id`, and either a `result` or an `error`:

```json
{"id": 3, "result": {"turnId": "turn-1"}}
{"id": 3, "error": {"code": "CONVERSATION_FORBIDDEN", "message": "Conversation not shared with you", "status": 403}}
```

`status` is present when the Juno server answered. A line that is not JSON gets `{"id": null, "error": {"code": "PARSE_ERROR", ...}}`.
A line without a valid `id` or a `method` gets `INVALID_REQUEST`. Its `id` is echoed when it has a valid one, else `null`.

An **event notification** carries a turn's events. It has no `id`:

```json
{"method": "event", "params": {"turn": "turn-1", "event": {"type": "text-delta", "text": "Hel"}}}
```

A **turn failure** is a notification too. It replaces `done` when the turn ends with an error (for example the
server refused the message):

```json
{"method": "turn.failed", "params": {"turn": "turn-1", "error": {"code": "CONVERSATION_FORBIDDEN", "message": "...", "status": 403}}}
```

## Methods

### `initialize`

Must be the first request. Params: `{"protocolVersion": 1}`. Result:

```json
{"protocolVersion": 1, "server": {"baseUrl": "https://juno.example.com"}}
```

`server` is the Juno server the session talks to: `{"baseUrl"}` for `--base-url`, or `"embedded"` once embedded mode
exists (see TODO below). The token is not echoed. A different `protocolVersion` gets `UNSUPPORTED_VERSION`.
Any other method before `initialize` gets `NOT_INITIALIZED`.

### `chat.open`

Params: `{"agentId": "agent-a"}` or `{"conversationId": "cvn-123"}`, exactly one. Opens the direct chat with the
agent (creating it on first use) or resumes the conversation. Result: `{"chatId": "cvn-123"}`. The chat id is the
conversation id. Opening the same conversation again returns the same chat.

Errors: `CONVERSATION_NOT_FOUND`, `INVALID_PARAMS`.

### `chat.send`

Params: `{"chatId": "...", "text": "..."}`. Result: `{"turnId": "turn-1"}`. The turn's events follow as `event`
notifications, in order, and end with an event of type `done`, or with `turn.failed`.

Approvals and questions are not answered automatically: each arrives as a `request` event, and the client answers it
with `chat.resolve`. The turn waits until it is answered.

### `chat.resolve`

Params: `{"requestId": "req-1", "decision": {"action": "approve"}}`. The decision is the server's
`ResolveRequestInput`. Result: the resolved request. The request must have been raised on a turn of this session;
otherwise `UNKNOWN_REQUEST`.

### `chat.stop`

Params: `{"chatId": "..."}`. Stops the run of the chat's current turn, the turn whose events are still streaming.
Result: `{"run": {...}}`, the run as the server answers the stop. The turn then ends with a `done` event whose run has
status `stopped`. Stopping does not close the turn's stream early; the `done` still arrives.

Errors: `NO_ACTIVE_RUN` (no turn is streaming on this chat, or its run is not known yet, for example for a room message
that woke several agents), `UNKNOWN_CHAT`.

### `shutdown`

Result: `{}`. The session then ends: no more lines are read and the process exits.

## Events

The `event` notification's `event` is the TypeScript SDK's `ChatEvent`, with the same fields:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `text-delta` | `text` | Streamed reply text. Provisional: use `message` for the committed reply. |
| `message` | `item` | An item the conversation gained (agent replies have `item.type` `agent_message`). The caller's own message is not repeated. |
| `tool` | `name`, `status` | A run step changed status: `pending`, `running`, `completed`, `failed` or `skipped`. |
| `request` | `request` | Approval, question or other request waiting on the client. Answer with `chat.resolve`. |
| `done` | `run` | The turn's run reached `completed`, `failed`, `stopped` or `blocked`. The turn is over. |

Objects (`item`, `request`, `run`) are the Juno public contracts, as the server sends them.

## Which run a turn follows

The send answers with the run its message is in, as the server names it. The turn follows that run and ends at its
`done`. If the send names no run (a room message that woke several agents, a message that woke nobody, a decision
that timed out, followup or interrupt), the turn follows a run that was already busy before the send, or else the
first new run the conversation starts. Events of other runs in the conversation are reported as `message` and `tool`
events but do not end the turn.

## Errors

| `code` | Cause |
| --- | --- |
| `PARSE_ERROR`, `INVALID_REQUEST` | The line is not JSON, or lacks `id` or `method`. |
| `METHOD_NOT_FOUND` | Unknown method. |
| `INVALID_PARAMS` | Missing or wrongly typed params. |
| `NOT_INITIALIZED` | A method was called before `initialize`. |
| `UNSUPPORTED_VERSION` | The client asked for another protocol version. |
| `UNKNOWN_CHAT` | No open chat has that id; call `chat.open` first. |
| `UNKNOWN_REQUEST` | The request is not pending on a turn of this session. |
| `NO_ACTIVE_RUN` | `chat.stop` with no run to stop. |
| `NETWORK_ERROR`, `INVALID_RESPONSE` | As in the SDK: the server could not be reached, or its answer did not match the contract. |
| `INTERNAL` | An unexpected failure in the session. |
| any server code | The Juno server's own `error.code` (for example `CONVERSATION_NOT_FOUND`), with `status`. |

## Example

```
-> {"id":1,"method":"initialize","params":{"protocolVersion":1}}
<- {"id":1,"result":{"protocolVersion":1,"server":{"baseUrl":"https://juno.example.com"}}}
-> {"id":2,"method":"chat.open","params":{"agentId":"agent-a"}}
<- {"id":2,"result":{"chatId":"cvn-1"}}
-> {"id":3,"method":"chat.send","params":{"chatId":"cvn-1","text":"hi"}}
<- {"id":3,"result":{"turnId":"turn-1"}}
<- {"method":"event","params":{"turn":"turn-1","event":{"type":"text-delta","text":"Hello"}}}
<- {"method":"event","params":{"turn":"turn-1","event":{"type":"done","run":{"id":"run-1","status":"completed"}}}}
-> {"id":4,"method":"shutdown"}
<- {"id":4,"result":{}}
```

## TODO: embedded mode

`--embedded` (start the backend in the client's process with `@agent-desktop/embedded`, `startEmbeddedJuno`) is
reserved. Today `juno serve --embedded` exits with an error saying so. The backend has no tag for
`packages/embedded`, and this package depends on the backend only through pinned tags, so there is nothing to
depend on yet. When the backend tags it: add it as a git+ssh dependency with a tag and a path, the way
`@agent-desktop/public-contracts` is pinned in `packages/client`, start it in `serve`, and report
`"server": "embedded"` from `initialize`.
