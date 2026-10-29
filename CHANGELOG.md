# Changelog

## Unreleased

- Refresh backend and frontend source to the current private mainline (backend public-contracts 0.71.0; frontend at its last pushed state, which is behind 0.71 until the client branch lands).
- Add `docs/ARCHITECTURE.md` and `docs/DEVELOPMENT.md` rewritten from the current code; remove historical design, audit, checklist and handoff documents.
- `deploy/`: pass the optional integration variables (Slack, Discord, Telegram, Google, Microsoft, Strava, Dropbox, Salesforce, Composio, push) into the app container; document each registration and multi-worker operation.
- Remove the product-film source, internal harness and one-off verification scripts, and private host names from examples.

## 0.1.0-alpha.1

- Include the optional local-computer Compose overlay in the public source tree.
- Record the Docker Desktop CLI qualification limit.

## Earlier

- Web, desktop, iOS, backend and the canonical public contracts in one source repository, with a server-deployment entry point.
