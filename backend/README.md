# Juno backend

API, agent runtime, durable workers, memory, chat-platform channels, connectors and computer services. Part of the Juno workspace: install and run checks from the repository root (`pnpm install`, `pnpm check`). Architecture: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). Local setup: [../docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md). Server deployment: [../deploy/README.md](../deploy/README.md).

```text
packages/
  public-contracts/  Wire schemas shared with every client (depends only on zod)
  api/               Public gateway :8787: accounts, settings, connector OAuth, webhooks, Web files
  agentd/            Private control and execution :8788
  juno-agent/        Agent kernel: harness, tools, tasks, memory, connectors
  channels/          Chat-platform adapters (Slack, Feishu, Discord, Telegram)
  durable/           Postgres-backed durable runner with leases
  computerd/         Private computer service :8791
  sandbox-adapters/  Local Docker and E2B transport, screen actions
  sandbox-image/     Recipe and assets for the computer image
  juno-link/         Daemon inside a computer (and on a Mac) that dials out to computerd
  memoryd/, memory-graph/  Memory service and its data model
  db/                PostgreSQL access and SQL migrations
  contracts/         Internal backend interfaces
  embedded/          Start api and agentd inside a script or test
  log/               Structured logging with secret redaction
services/            spaces-host (Cloudflare worker for shared apps), tts (speech sidecar)
tests/e2e/           End-to-end suite against the real stack
```

Copy `.env.example` to `.env` for local development; it is gitignored. Never put real secrets in the example file.
