# Development

Use Node 26 and pnpm 12.9.1. One workspace at the repository root covers `backend/`, `frontend/` and their packages.

```sh
pnpm install
pnpm check          # backend check, then frontend check
```

`pnpm check` runs, per side: lint, structure and quality scripts, typecheck, the single-source contract check and a duplication scan. Run package tests one package at a time, for example `pnpm --filter @agent-desktop/agentd test`; the full `pnpm test` is heavy. Public contracts and `juno-link` resolve inside the workspace; do not add dependencies on unpublished repositories or a local checkout.

## Backend

```sh
cp backend/.env.example backend/.env         # edit the secrets; add a model provider
pnpm -C backend dev:infra                    # Postgres 18 in Docker on 127.0.0.1:54330
pnpm -C backend db:migrate                   # apply SQL migrations
pnpm -C backend dev:backend                  # api :8787, agentd :8788, computerd :8791, memoryd :8796
```

`dev:backend` never seeds, resets or wipes data. `DEV_AGENTD_WORKERS=2` splits agentd into a coordinator plus two workers, like a scaled deployment. Computers: set `COMPUTER_PROVIDER=local` (Docker, with the image from `backend/packages/sandbox-image`) or the E2B settings in `.env`; with neither, agents have no computer.

Tests: unit suites sit beside the code (`vitest`). `pnpm -C backend test:e2e` starts the real API, agentd and computerd on free ports against a scratch embedded Postgres, with a scripted model, and never reads your `.env`. `pnpm -C backend test:e2e:real` runs against a real model that you configure (`E2E_REAL_MODEL` and your provider settings); it costs tokens. Say which you ran when you report results.

## Frontend

```sh
pnpm --filter @agent-desktop/web dev         # Web app on :5199, proxies /v1 and /auth to :8787
pnpm --filter @agent-desktop/desktop dev     # Electron desktop (macOS)
pnpm --filter @agent-desktop/ui storybook    # component stories
```

The desktop app and the iPhone app connect to a Juno server; set the server in the app or in `frontend/.env.example`'s variables. For iOS, open `frontend/packages/ios/Juno.xcodeproj` (generated from `project.yml` with XcodeGen), pick your own signing team and bundle identifier, and point it at your server. The development team in the iOS and watchOS projects (`DEVELOPMENT_TEAM` in `frontend/packages/ios/project.yml` and `frontend/packages/watch/project.yml`) is empty; set your own Apple team before building. Server deployment does not build the desktop or iOS clients.

## Changing a contract

Edit the schema in `backend/packages/public-contracts` and bump its package version. Regenerate the native types with `pnpm -C frontend gen:swift` and `gen:kotlin`, update `packages/client` and the fixtures in `frontend/tests/fixtures`, then run `pnpm contracts:check`.

## Hygiene

Never run reset or seed commands against a database that holds real data. Do not commit credentials, local state, personal transcripts or generated builds; use synthetic examples. Deployment changes must pass `node deploy/setup.mjs --check`, and a fresh-install smoke test before they are claimed to work (`scripts/verify/deploy-live.mjs`, see deploy/README.md). `node scripts/verify/public-source.mjs` scans the tree for private files and obvious credentials.
