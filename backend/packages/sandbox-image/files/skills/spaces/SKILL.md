---
name: spaces
description: Build a small web app (notes, tracker, dashboard, tool, mini game) that runs in this computer and that the user opens from the chat. Use when a one-file page is not enough: data that is saved, several pages, an API.
---
# Spaces: small apps the user can open

An app lives in `/workspace/spaces/<slug>/`. It runs here, as you, on a port the platform gives it; the user opens it from a card in the chat (only they can). While this computer is paused the app is paused. For a single static page with no saved data use `artifact_publish` instead.

Tool: `/opt/juno/skills/spaces/spaces_tool.py` (Bun is installed and the template dependencies are preinstalled (installed offline from a copy of the cache the first time), so there is no network install; do not add new packages).

1. `spaces_tool.py new <slug> [--template app|static]`. `app` (default) is a Vite + React client, a Bun server in `server.ts` using Hono for `/api/...`, and SQLite through Drizzle: schema in `schema.ts`, SQL in `migrations/` (applied when the server starts; after changing `schema.ts` run `bun run db:generate` in the folder). The database file is `data/app.db` inside the app folder. `static` is plain files in `public/`.
2. Edit the files with your file tools. Keep it small and working; check the page yourself in the browser before telling the user. For `app`, `spaces_tool.py build <slug>` rebuilds the client (needed after every client change).
3. Call `space_publish {path: "/workspace/spaces/<slug>", title}`. The first call only allocates the port (it is written to `.juno-port`) and tells you to start the app. `spaces_tool.py port <slug>` prints it.
4. Start the app as a background process (shell_start): `/opt/juno/skills/spaces/spaces_tool.py start <slug>`. It reads `.juno-port` and listens on `127.0.0.1` only. Your own server code must also bind `127.0.0.1` and use that port: the platform refuses an app that listens elsewhere or on a port that is not its own.
5. Call `space_publish` again with the same path. The platform checks the app is listening, wires it up and posts the app card in the chat. After later changes, rebuild, restart the process and call `space_publish` again with the `spaceId` it returned to update the title or port.

Notes: no secrets, API keys or passwords in the app (anyone who can use this computer as an agent can read its files); the app has no login of its own because only the owner can reach it; restart the process yourself after a pause or reboot if the card says the app is not running.
