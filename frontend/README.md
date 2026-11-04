# Juno frontend

Web, Electron desktop, iPhone, Apple Watch and Android clients, the TypeScript SDK, and the shared client and UI packages. Part of the Juno workspace: install and run checks from the repository root (`pnpm install`, `pnpm check`). See [../docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md).

```text
packages/
  web/        Browser entry and dev server (:5199)
  desktop/    Electron host, "My Mac" helper, Chrome bridge
  app/        Shared product pages and state
  ui/         Design tokens and reusable components (Storybook)
  client/     HTTP/SSE client; re-exports the public contracts
  sdk/        TypeScript SDK and `juno serve`
  ios/        Native iPhone app (SwiftUI, XcodeGen project.yml)
  watch/      Apple Watch companion
  android/    Android client (in progress)
tests/fixtures/  Test doubles for the API
```

The iPhone and Watch apps read their server from the `JUNO_SERVER_URL` build setting (placeholder `https://juno.example.com` in `packages/ios/Config/Juno.xcconfig` and `packages/watch/Config/Juno.xcconfig`). Set yours in `Config/Server.local.xcconfig` next to each (gitignored), e.g. `JUNO_SERVER_URL = https:/$()/your.server`; `$()` keeps the `//` from starting an xcconfig comment.

Clients talk to the backend only through the public HTTP, SSE and WebSocket API. Wire schemas come from `backend/packages/public-contracts`; never copy them. Swift and Kotlin types are generated (`pnpm -C frontend gen:swift`, `gen:kotlin`).
