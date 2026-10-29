# How Juno fits together

Juno is a server that hosts persistent AI agents. People talk to an agent in the Juno apps or in the group chats they already use (Slack, Feishu, Discord, Telegram). The agent works on a cloud computer and in connected apps, asks before it does anything with consequences, and keeps selected context for later. One server serves many owners; each owner's data is scoped to that owner.

## Services

| Service | Package | Job |
|---|---|---|
| API | `backend/packages/api` | The only public entry. Accounts and sessions (Better Auth), settings, library, connector OAuth, channel webhooks, signed computer-stream tickets, and the Web app files. Forwards agent traffic to agentd. |
| agentd | `backend/packages/agentd`, `juno-agent` | Private. Owns agents, conversations, requests and approvals, routines, goals and the event stream. Runs the harness: the model loop (Pi AI and Pi Agent Core), tools, context building and compaction. |
| computerd | `backend/packages/computerd`, `sandbox-adapters` | Private. One computer per owner, one screen per agent. Allocates screens, serves screen actions, bridges the live view and take-over, pauses and resumes. |
| memoryd | `backend/packages/memoryd`, `memory-graph` | The memory read/write port. Runs inside agentd unless `MEMORYD_URL` points at a separate process. |
| PostgreSQL | `backend/packages/db` | The only database: documents, durable-run tables and the event log. File bytes are not stored in it; they go to the blob directory or S3-compatible storage. |

The shipped Compose deployment runs API, agentd and computerd as three processes in one container on its loopback, behind Caddy. agentd and computerd never listen on a public interface. Internal calls carry a service bearer; the API resolves the owner and passes it on.

## Durable work

Agent runs, routines, timers and waits for approval run on `backend/packages/durable`, a small Postgres-backed runner: an invocation table, a journal of completed steps, per-key object state and wait records. A crashed run replays its journal; steps that finished are not repeated, and tools with side effects are fenced so a replay does not perform them twice. Waiting for a person suspends the run instead of holding a process.

The runner scales out. `AGENTD_ROLE` is `all` (one process, the default), `coordinator` or `worker`. The coordinator holds a database-wide lock and owns the singletons: HTTP, platform gateways and pollers, migrations, timers and retention jobs. Workers claim invocations under leases that expire if a worker stops renewing, so another worker takes over, and they wake on Postgres notifications instead of polling. Coordinator and workers must run the same build. Connection use grows with the worker count; `packages/db/src/connection-budget.ts` checks it at start-up.

## Chat platforms

A platform is one adapter in `backend/packages/channels` (capabilities, identity, outbound sender, and optional abilities such as reactions, history and attachments) plus one plugin in `backend/packages/agentd/src/channels/<platform>` (connect flow, runner, webhook). Core code does not branch on a platform name, so adding a platform means adding an adapter and a plugin. Slack and Discord use one app or bot for the whole server and give each agent a user group or role to mention. Telegram creates a bot per agent through a manager bot. Feishu creates an app per agent by QR scan. Every message carries its speaker's relationship to the owner; strangers get a restricted tool set, and private memory is not read out in a group.

## Connectors

The Apps page has one catalog and three sources:

1. Official: first-party connectors and hosted MCP servers whose login Juno holds (Google, Microsoft 365, Notion, Linear, Stripe and others; see `juno-agent/src/modules/mcp/catalog.ts`). Some need an OAuth client the operator registers, and are hidden until it is configured.
2. Composio: a long tail of apps whose login Composio holds. Offered only when `COMPOSIO_API_KEY` is set.
3. Custom MCP: a URL the owner adds. A probe reads the server's authentication and tool list without credentials, and the owner confirms before it is installed. A tool whose definition changes later is held for review.

All three share the same access states, read-versus-change tool marks and approvals. Agents cannot create connectors.

## Approvals

A tool that changes something outside Juno raises a request carrying a decision brief: who acts, as which account, what changes, and what can be undone. The owner resolves it in the app or the chat platform; rules can delegate a category of actions within limits. Only the reviewed call runs, once, within its validity window.

## Computers

An agent's screen lives on its owner's computer: a Debian desktop with a browser, terminal and files, built from `backend/packages/sandbox-image`. Agents on one computer are isolated as separate Linux users. A daemon inside the computer (`juno-link`) dials out to computerd, so the computer needs no inbound port; commands, files and the live view travel over that one connection. A provider only starts and stops computers: local Docker, or self-hosted E2B. The same link carries "My Mac", the owner's own Mac, which agents may use after per-app approval.

## Memory

Each agent has a home of files (identity, memory, skills) mirrored and indexed in Postgres. Memory entries describe the owner, other people and relationships, with provenance, and are read through a presence filter so a group never receives what only the owner may see. Background jobs tidy memory, write topic summaries and, nightly, review recent conversations. Skills are versioned: outcomes label them, edits roll out to a small share first, and a worse result rolls back automatically. Compacting a long conversation keeps the original transcript.

## Clients

`frontend/` holds the Web app (`packages/web`, built from the shared `app` and `ui` packages), the Electron desktop app, the native iPhone and Watch apps, an Android client in progress, a TypeScript SDK with a `juno serve` JSON-lines protocol, and a Chrome extension that lets agents use pages where the owner is signed in. Clients speak only the public HTTP, SSE and WebSocket API, through `packages/client`.

## Public contracts

`backend/packages/public-contracts` is the one source of wire schemas (zod). Clients import it and never copy schemas. Swift and Kotlin types are generated from it (`pnpm -C frontend gen:swift`, `gen:kotlin`) and checked for drift. `pnpm contracts:check` fails if a schema is duplicated outside it. Changing a schema bumps the package version.

## Deployment

`deploy/` builds one server image and a Caddy edge image and runs them with PostgreSQL under Compose. See [deploy/README.md](../deploy/README.md).
