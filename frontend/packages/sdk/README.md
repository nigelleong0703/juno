# @juno/sdk

TypeScript SDK for Juno. A chat turn is an async iterator, approvals can be answered by a callback, a
conversation can be resumed by id, and background task completions arrive as events.

It is built on the workspace client's HTTP and SSE code (`@agent-desktop/client/http`), so the wire
behaviour (bearer auth, zod-validated responses, `Last-Event-ID` resume, dedupe) is the app's own.

## Install and build

The package is private for now. Inside this workspace:

```sh
pnpm --filter @juno/sdk build   # dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts, dist/cli.js (the juno command)
pnpm --filter @juno/sdk test
```

The library bundle contains everything except `zod`. For programs in other languages, the `juno serve`
command speaks a JSON-lines protocol on stdin and stdout; see [PROTOCOL.md](./PROTOCOL.md):

```sh
JUNO_BASE_URL=https://juno.example.com JUNO_TOKEN=... node dist/cli.js serve
```

The server comes from `JUNO_BASE_URL` and `JUNO_TOKEN`. `--base-url` and `--token` override them, but a
`--token` value is visible in the process list on some systems, so prefer the environment. See
[PROTOCOL.md](./PROTOCOL.md).

## Example: a chat turn

```ts
import { createJuno } from '@juno/sdk';

const juno = createJuno({ baseUrl: 'https://juno.example.com', token: process.env.JUNO_TOKEN! });
const chat = await juno.chat({ agentId: 'agent-a' });

for await (const event of chat.send('What can you help me with today?')) {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.text);
      break;
    case 'message':
      console.log(`\n[${event.item.type}]`);
      break;
    case 'tool':
      console.log(`\n[tool ${event.name}: ${event.status}]`);
      break;
    case 'request':
      console.log(`\n[waiting on you: ${event.request.title}]`);
      break;
    case 'done':
      console.log(`\n[run ${event.run.status}]`);
      break;
  }
}

await juno.close();
```

## Example: an approval callback

When `onApproval` is given, approvals and questions the run raises during the turn are answered by the
callback. The decision is sent to the server and the run carries on. These requests are not yielded.

```ts
import { createJuno, type Request } from '@juno/sdk';

const juno = createJuno({ baseUrl: 'https://juno.example.com', token: process.env.JUNO_TOKEN! });
const chat = await juno.chat({ agentId: 'agent-a' });

async function askOwner(request: Request): Promise<{ action: 'approve' | 'deny' }> {
  console.log(`\n[approval] ${request.title}`);
  return { action: 'deny' }; // decide however your app asks the owner
}

for await (const event of chat.send('Email the weekly summary to the team.', { onApproval: askOwner })) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log(`\n[run ${event.run.status}]`);
}

await juno.close();
```

Without `onApproval`, the turn yields a `request` event. Answer it inside the loop with
`chat.resolve(request.id, decision)`. The run waits until you do.

## Example: resume a conversation

```ts
import { createJuno } from '@juno/sdk';

const juno = createJuno({ baseUrl: 'https://juno.example.com', token: process.env.JUNO_TOKEN! });
const chat = await juno.chat({ conversationId: 'cvn-123' }); // an id from an earlier session or the app
console.log(`resumed ${chat.id}`);

for await (const event of chat.send('Where did we leave off?')) {
  if (event.type === 'text-delta') process.stdout.write(event.text);
  if (event.type === 'done') console.log(`\n[run ${event.run.status}]`);
}

await juno.close();
```

## Background task events

```ts
const stop = juno.on('task.finished', (task) => {
  console.log(`${task.title}: ${task.status} (${task.outcome ?? 'no outcome'})`);
});
// later
stop();
```

Fires once per task when it reaches `completed`, `failed` or `stopped`.

## API

| Call | Result |
| --- | --- |
| `createJuno({ baseUrl, token, fetch? })` | A client. Nothing is requested until a chat is opened or a listener is added. |
| `juno.chat({ agentId })` | The direct chat with the agent: the existing one, or a new one on first use. |
| `juno.chat({ conversationId })` | The conversation with that id (`404 CONVERSATION_NOT_FOUND` if unknown). |
| `chat.send(text, { onApproval? })` | `AsyncGenerator<ChatEvent>`. Posts the message when iteration starts, ends when the turn's run finishes. |
| `chat.resolve(requestId, decision)` | Answers a pending request. The decision is the server's `ResolveRequestInput`, e.g. `{ action: 'approve' }`. |
| `chat.stop()` | Stops the run of the turn being iterated (`POST /v1/runs/:id/stop`). Resolves to the run; the turn then ends with `done` and status `stopped`. Rejects with `NO_ACTIVE_RUN` if no turn is being iterated or its run is not known yet. |
| `juno.on('task.finished', handler)` | Unsubscribe function. |
| `juno.close()` | Stops the stream. An open turn rejects with `CLOSED`. |

### Events

| `type` | Payload | Notes |
| --- | --- | --- |
| `text-delta` | `text` | Streamed reply text. Provisional: an attempt can be discarded. |
| `message` | `item` | Each item the conversation gains during the turn, except your own message. Agent replies are `item.type === 'agent_message'`. |
| `tool` | `name`, `status` | A run step (tool call) changed status: `pending`, `running`, `completed`, `failed` or `skipped`. |
| `request` | `request` | Approval, question or other request waiting on you (no `onApproval`, or a kind it does not answer). |
| `done` | `run` | The run is `completed`, `failed`, `stopped` or `blocked`. Check `run.status` and `run.error`. |

The `message` event is the authoritative reply. Use `text-delta` for display only.

### Errors

Every rejection is a `JunoError` with a `code`:

- `JunoApiError` (extends `JunoError`): the server answered non-2xx. `status`, `code` and `message` are the
  server's own `{ code, message }`, for example `CONVERSATION_FORBIDDEN`. Also `fields` on a 400 and
  `retryAfterSec` on a 429.
- `NETWORK_ERROR`: the request never got a response.
- `INVALID_RESPONSE`: the response did not match the Juno contract.
- `CLOSED`: the client was closed while the call or turn was open.
- `INVALID_ARGUMENT`: a bad `createJuno` option or event name.

```ts
import { JunoApiError, JunoError } from '@juno/sdk';

try {
  await juno.chat({ conversationId: 'cvn-123' });
} catch (error) {
  if (error instanceof JunoApiError && error.code === 'CONVERSATION_NOT_FOUND') {
    // start a new conversation
  } else if (error instanceof JunoError) {
    throw error;
  }
}
```

## How a turn finds its run

`POST /v1/conversations/:id/messages` answers `202 { item, runId }`. The turn follows the run named by
`runId`, which is the run the message is in: the run it started, or the busy run it steered into. The turn
ends at that run's `done`. Only that run ends the turn. A run started by something else in the same
conversation shows up as `message` and `tool` events but does not end it.

When `runId` is `null`, the send names no single run: a room message that woke several agents (each has
its own run), a message that woke nobody, a decision that timed out (the server still processes it, so do
not resend), or a followup or interrupt. Then the turn follows a run that was already busy in the
conversation before the send, or else the first new run the conversation starts after it. This fallback is
the only place the SDK infers a run; `chat.stop()` is unavailable until the run is known.

Events that arrive between turns are not dropped: the stream resumes from its last event id, so the next
turn receives them.

## Limitations

- Breaking out of the loop stops listening only. Call `chat.stop()` while iterating to stop the run.
- `send` takes plain text. Attachments and mentions are not exposed yet.
- The declarations (`dist/index.d.ts`) import the workspace types `@agent-desktop/client`. That works in
  this monorepo, but a published package needs a declaration bundle first.
