# Changelog

## Unreleased

- Sync backend and frontend source to the current private mainline (backend public-contracts 0.81.0, frontend at the matching client state).
- Voice calls: owner-scoped in-app calls over LiveKit (`services/voice` worker, `/v1/conversations/:id/voice-calls`, `voice-call` contract), a warmed run prefix, and a voice channel for agent replies. Off unless the LiveKit and speech-provider variables in `backend/.env.example` are set (the dev launcher starts the worker when `VOICE_ENABLED=1`); it is not part of the Docker deployment. The iPhone app gains the call screen, live transcript and Watch listening (the Watch's CoreML models are fetched with `scripts/fetch-models.sh`, not committed).
- Live run text streams in process, and in-flight replies read as one bubble per reply.
- Agents in groups: observed group messages, per-group settings, teammate permissions, Slack-native surfaces (`/juno`, message shortcut, canvas) and an outbox with retry, visibility and a pause switch for every delivery to a chat platform or phone.
- iPhone access (contacts, location, health, photos, music, home, reminders) through the device-call path; undo for agent file writes with kept versions; memory per agent with items the owner can share.
- Subagents replace "child" tasks throughout (wake kind, harness units, tools, UI); background subagent runs, deep research and deep search skills.
- Memory vectors move to pgvector (`vector(n)` with an HNSW index): the infra compose file uses `pgvector/pgvector:pg18` and the server's Compose PostgreSQL image is rebuilt from `postgres:18-alpine` with pgvector, so existing volumes upgrade in place, and unit suites install a test-only stand-in on the embedded cluster.
- Sandbox: one network namespace per agent with an egress guard, shorter idle pause, orphan sweep, platform skills synced by content version; the image builds on E2B cloud (`E2B_API_KEY`).
- Connectors: hosted connectors are internal and answer only `HOSTED_MCP_TOKEN`; Asana added; Strava, Dropbox and the Singapore transport connector removed.
- Contract and quality: public-contracts 0.72.0 to 0.81.0 (deletion events, outbox, file history, group settings, voice call, memory `agentId`), a plain-sentence rule for failed runs, and MCP argument checks that resolve `$ref`.
- Refresh backend and frontend source to the current private mainline (backend public-contracts 0.71.0; frontend at its last pushed state, which is behind 0.71 until the client branch lands).
- Add `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` rewritten from the current code; remove historical design, audit, checklist and handoff documents.
- `deploy/`: pass the optional integration variables (Slack, Discord, Telegram, Google, Microsoft, Strava, Dropbox, Salesforce, Composio, push) into the app container; document each registration and multi-worker operation.
- Remove the product-film source, internal harness and one-off verification scripts, and private host names from examples.

## 0.1.0-alpha.1

- Include the optional local-computer Compose overlay in the public source tree.
- Record the Docker Desktop CLI qualification limit.

## Earlier

- Web, desktop, iOS, backend and the canonical public contracts in one source repository, with a server-deployment entry point.
