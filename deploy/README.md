# Server deployment

The deployment is four Compose services: PostgreSQL, a one-shot SQL migration, the Juno app container, and Caddy. The app container runs the production API, agentd and computerd entry points under `supervise.mjs`; they share loopback because agentd/computerd deliberately bind to `127.0.0.1`. API binds `0.0.0.0` inside that container so Caddy can reach it on the private Compose network. PostgreSQL and the internal service ports have no host port mappings. Caddy is the only public edge.

## First start

Install Docker Engine with Compose v2 and Node 26, then from the repository root:

```sh
node deploy/setup.mjs --check
```

This creates `deploy/.env` if needed, generates missing secrets once, keeps existing values, enforces mode `600`, checks the PostgreSQL URL against its credentials, validates auth/content hosts and ports, and asks Docker Compose to parse both deployment configurations. It also verifies the app and edge build definitions and confirms that Caddy has no host file mounts while its named data/config volumes remain. It never reads the repository root `.env`. Back up `deploy/.env`, especially `SECRETS_KEY`; losing that key makes stored integration secrets unreadable.

Set `MODEL_BASE_URL`, `MODEL_ID` and `MODEL_API_KEY` in `deploy/.env` to enable the platform model. You can pass `--model-base-url` and `--model-id` to setup; avoid `--model-key` on shared systems because command-line arguments may appear in shell history or process listings. Setup never invents a model or substitutes a scripted one. `--check` accepts a missing platform model and reports that agent runs need an owner-configured provider. `--up` requires `MODEL_BASE_URL` and `MODEL_ID`, or an explicit acknowledgment for a web/API-only launch:

```sh
node deploy/setup.mjs --up --allow-unconfigured-model
```

Otherwise run `node deploy/setup.mjs --up` after configuring the model. Compose builds both `juno-server` and `juno-edge` from the repository root. The edge image copies both `deploy/Caddyfile` and `deploy/Caddyfile.qa` into `/etc/caddy`; `CADDYFILE_PATH` selects one of those bundled files and is restricted by setup to those two choices. Caddy receives no host file mounts, so Docker Desktop does not need to bind a config from the Desktop directory. The Caddy data and config named volumes remain persistent. If you edit either bundled Caddyfile, rebuild the edge image with `docker compose --env-file deploy/.env -f deploy/compose.yml build edge` or rerun setup with `--up`.

Setup waits for Postgres, runs SQL migrations once, starts the app and edge, and waits for `/healthz`. The API serves the compiled Web files from `/app/web-dist` on the same origin. The app's `/healthz` checks PostgreSQL and agentd readiness.

The template uses loopback QA ports `18487`/`18488`. For a public server, edit `deploy/.env` before `--up`:

```dotenv
EDGE_HTTP_PORT=80
EDGE_HTTPS_PORT=443
EDGE_HTTP_BIND=0.0.0.0
EDGE_HTTPS_BIND=0.0.0.0
BETTER_AUTH_URL=https://juno.example.com
API_SITE=juno.example.com
ARTIFACT_HOST=usercontent.example.net
ARTIFACT_SITE=usercontent.example.net
SPACE_DOMAIN=spaces.example.org
SPACE_WILDCARD=*.spaces.example.org
CADDYFILE_PATH=./Caddyfile
```

Point DNS for the API and artifact names to the server, and a wildcard DNS record `*.spaces.example.org` to the same edge. The three registrable domains must be separate for HTTPS. Setup enforces that rule, along with matching API/Caddy origins. Caddy obtains API certificates automatically and uses on-demand TLS for artifact and existing Space hosts; its `ask` callback calls the API's `/v1/edge/tls-check`, which only approves the configured artifact host and a real published Space. Do not put untrusted content on the API registrable domain. On-demand certificate issuance requires public DNS and ports 80/443 reachable from the ACME issuer.

If port 80/443 are already occupied, stop the service that owns them or choose another deployment host. The API, agentd, computerd, computer-link listener and PostgreSQL are not published on public interfaces.

## Computers are optional and lazy

The base deployment includes computerd but creates no computer image or sandbox at startup. `COMPUTER_PROVIDER=local` is the default; a requested computer requires the local sandbox image and Docker Engine access. No fake provider is configured.

On Linux, `host.docker.internal` in a sandbox resolves to the Docker host gateway, not host loopback. A host port published on `127.0.0.1` is unreachable from that sandbox. To enable local computers, first inspect the actual default bridge gateway:

```sh
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

Set that exact non-loopback IPv4 address as `DOCKER_BRIDGE_HOST` in `deploy/.env`, build the `juno-desktop:local` image documented by `backend/packages/sandbox-image`, and start with the optional overlay:

```sh
node deploy/setup.mjs --up --allow-unconfigured-model --local-sandbox
```

The overlay mounts `/var/run/docker.sock` into the app container and binds the computer-link port only to `DOCKER_BRIDGE_HOST`; the script verifies it matches the active bridge gateway. Access to the Docker socket grants host-level control. Keep this overlay and port off servers where that trust is not acceptable. The sandbox connects to `host.docker.internal:<COMPUTERD_LINK_PORT>` through Docker's `host-gateway` mapping. Do not set the link URL to `127.0.0.1` on Linux.

For E2B, set `COMPUTER_PROVIDER=e2b`, `E2B_API_KEY`, both `E2B_API_URL` and `E2B_SANDBOX_URL`, and a public `wss://` `COMPUTERD_LINK_URL`. The link websocket is routed by Caddy on the API hostname to the app's private port 8795. The external E2B sandbox must be able to reach that HTTPS endpoint. `setup --check` rejects a partial E2B configuration.

Memory runs inside agentd by default; no memoryd container is required. Set `MEMORYD_URL` only when intentionally deploying a separately managed memoryd service with a shared `MEMORYD_TOKEN`.

## What is optional

Required for a working server: PostgreSQL, the app container, Caddy and the generated secrets. Everything else is optional and off until configured, and Juno never substitutes a fake: a model provider (platform default in `deploy/.env`, or each owner's own in Settings), computers, chat platforms, connectors that need a registered client, Composio, push notifications, web search. The Web app works without any of them; an agent without a model cannot run, and an owner without a computer gets an agent with no computer tools.

## Integrations

Put each value in `deploy/.env` (the template lists them commented out under "Integrations"), then re-run `node deploy/setup.mjs --up`; the variables are passed into the app container by `deploy/compose.yml`. A blank variable means the integration is not offered. Every callback below is built from `BETTER_AUTH_URL`, so it must be the exact public `https://` address of the server before you register anything. Registering an app on a provider's console follows that provider's own documentation; Juno only needs the values and URLs here.

`CHANNELS_PUBLIC_URL` is the base URL the chat platforms use to reach this server. Set it to the same value as `BETTER_AUTH_URL` on a public server. Slack and Discord installs are refused without it, and Telegram polls instead of receiving webhooks.

| Integration | Variables | What you register and where Juno needs to be reached |
|---|---|---|
| Slack (one shared app, installed per workspace) | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Events request URL `<CHANNELS_PUBLIC_URL>/v1/channels/slack/events`, interactivity URL `<CHANNELS_PUBLIC_URL>/v1/channels/slack/interactions`, OAuth redirect URL `<CHANNELS_PUBLIC_URL>/v1/channels/slack/oauth/callback`. Bot scopes: `app_mentions:read`, `chat:write`, `chat:write.customize`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `channels:read`, `groups:read`, `reactions:write`, `files:read`, `files:write`, `users:read`, `users:read.email`, `usergroups:read`, `usergroups:write`. Bot events: `app_mention`, `message.im`, `message.channels`, `message.groups`. Per-agent user groups need a paid Slack plan; on a free workspace the agent stays connected without a handle. |
| Discord (one shared bot, invited per server) | `DISCORD_APP_ID`, `DISCORD_BOT_TOKEN` | OAuth redirect `<CHANNELS_PUBLIC_URL>/v1/channels/discord/oauth/callback`. Enable the privileged Message Content intent for the application, otherwise only bot mentions and DMs carry text. The bot opens one Gateway connection from the server; no inbound webhook is used. |
| Telegram (one manager bot, one bot per agent) | `TELEGRAM_MANAGER_BOT_TOKEN` | A bot with Bot Management Mode enabled in @BotFather. The manager bot is read by long polling, so it needs no public URL. Without the variable Telegram is hidden. |
| Feishu / Lark | none | Owners create an app per agent by scanning a QR code; the server keeps a long connection per app. Nothing is registered by the operator. |
| Google (Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | A web OAuth client with redirect URI `<BETTER_AUTH_URL>/oauth/mcp/callback`. The Gmail, Drive and Calendar scopes Juno requests are Google "restricted" scopes, which need Google's app verification before people outside your own test users can sign in. |
| Microsoft 365 (Outlook, Calendar, To Do, OneDrive, Contacts, Teams) | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | An Azure app registration for work, school and personal accounts, Web redirect URI `<BETTER_AUTH_URL>/oauth/mcp/callback`. |
| Strava | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | A client registered with Strava for `<BETTER_AUTH_URL>/oauth/mcp/callback`. |
| Dropbox | `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET` | A Dropbox app with redirect URI `<BETTER_AUTH_URL>/oauth/mcp/callback` and scopes `account_info.read`, `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`. |
| Salesforce (read-only hosted MCP) | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | The client of an External Client App you register; each customer org's admin must install it. Requested scopes: `mcp_api`, `refresh_token`. |
| Composio (long-tail apps) | `COMPOSIO_API_KEY`; `COMPOSIO_AUTH_CONFIG_SPOTIFY`, `COMPOSIO_AUTH_CONFIG_SHOPIFY` | A Composio project key. Spotify and Shopify have no Composio-managed OAuth app, so each needs your own OAuth app registered as a Composio auth config; put its id in the matching variable or that app is not offered. Composio returns people to `<BETTER_AUTH_URL>/oauth/composio/callback`. Rotating the key requires owners to reconnect their Composio apps. |
| Deployment-key connectors | `GOOGLE_MAPS_API_KEY`, `YOUTUBE_API_KEY`, `LTA_ACCOUNT_KEY` | Maps (Maps Grounding Lite), public YouTube search, and Singapore transport (LTA DataMall). Each is offered only when its key is set. |
| Push notifications (iPhone) | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY`, `APNS_TOPIC` | An Apple developer team key. `APNS_KEY` holds the `.p8` PEM with `\n` escapes. Push stays off if unset. |
| Web search | `SEARCH_PROVIDER` (`brave` or `tavily`), `SEARCH_API_KEY` | Without it the `web_search` tool is absent; `web_fetch` needs no key. |

`MCP_OAUTH_RETURN_URL` (default `<BETTER_AUTH_URL>/connectors`) is where the browser lands after a connector sign-in. `MCP_OAUTH_APP_RETURN_URLS` (default `juno://connectors`) lists extra return URLs a native app may ask for. `PUBLIC_ORIGINS` adds other public addresses the API is reached on; each one's `/oauth/mcp/callback` must be registered with the providers.

Any app that is not in the catalog can be added by an owner as a custom MCP server by URL. `ADMIN_TOKEN` (generated by setup) enables the operator's catalog path `/admin/v1/apps`; leave it unused if you do not curate the catalog.

## Scaling out workers

The default container runs one agentd process with `AGENTD_ROLE=all`, which is enough for a small server and is what the smoke test covers. agentd can also run as one `coordinator` plus several `worker` processes on the same database, so runs continue when a worker stops and rolling restarts do not interrupt them. The shipped Compose file does not start workers; to use them, run the extra agentd processes yourself with the same image and environment, `DATABASE_URL`, `SECRETS_KEY`, `INTERNAL_AGENTD_TOKEN`, `COMPUTERD_URL` and `COMPUTERD_TOKEN`, and the same blob volume.

| Variable | Meaning |
|---|---|
| `AGENTD_ROLE` | `all` (default), `coordinator` or `worker`. Exactly one coordinator or `all` process may run per database; a second one waits for the lock. |
| `AGENTD_WORKER_ID` | Unique name of the process, written into its leases. Defaults to host, pid and a random suffix. |
| `AGENTD_WORKER_CONCURRENCY` | Invocations one worker runs at once. Defaults to 8 for `worker`, unlimited for `all`. |
| `AGENTD_LEASE_TTL_MS` | A lease that is not renewed for this long is taken over (default 15000, minimum 3000). |
| `AGENTD_EXPECTED_WORKERS` | Number of workers you plan to run; used to check the database connection budget at start-up. |
| `AGENTD_DB_POOL_MAX`, `AGENTD_WORKER_DB_POOL_MAX`, `API_DB_POOL_MAX`, `MEMORYD_DB_POOL_MAX` | Pool sizes. The start-up check refuses a combination that exceeds PostgreSQL's `max_connections`. |

Start order for an upgrade: apply migrations, start the new coordinator (the old agentd must already be stopped), then the workers. Workers refuse to start while no live coordinator has announced worker leases. To roll back, stop all workers first, then the coordinator, then start the old build. Run coordinator and workers from the same build. Worker leasing is tested in the backend end-to-end suite on a split stack; the Compose deployment itself is not tested with workers.

## QA and operations

The disposable QA project can use the documented loopback ports without touching another Compose project:

```sh
node deploy/setup.mjs --up --project juno-release-qa --allow-unconfigured-model
node scripts/verify/deploy-live.mjs
```

`--project` scopes Compose containers, networks and named volumes. Do not run `docker compose down -v` without that exact project name: `-v` deletes its database and app data. The smoke verifier creates one synthetic account and writes its session cookie to `.data/deploy-smoke.json` with mode `600`; it does not use a real account. Restart persistence can be checked with `node scripts/verify/deploy-live.mjs --verify-persistence` after restarting only the same QA app:

```sh
docker compose --project-name juno-release-qa --env-file deploy/.env -f deploy/compose.yml restart app
node scripts/verify/deploy-live.mjs --verify-persistence
```

For routine inspection use `docker compose --project-name juno --env-file deploy/.env -f deploy/compose.yml ps` and `logs --tail=100`. Upgrade with `node deploy/setup.mjs --up`; this builds both app and edge images, and the migration command is safe to rerun and only applies unapplied SQL files. Named PostgreSQL, app blob/cache and Caddy certificate/config volumes persist across container replacement.

Back up PostgreSQL and the app-data volume before upgrades. Example database dump:

```sh
docker compose --project-name juno --env-file deploy/.env -f deploy/compose.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > juno-postgres.sql
```

For a consistent backup, pause app writes before `pg_dump`, archive the Compose volume whose name ends in `_app-data` separately, then resume the app. The command runs `pg_dump` inside the container so it uses the container's configured database credentials. Store both backups and `deploy/.env` encrypted off-host. Restore the database dump into PostgreSQL first, restore app data into its named volume, then start the matching app image. Caddy's certificate volume can be recreated, though doing so may trigger ACME rate limits if repeated often.

Never use the sample web or backend `.env` files as production credentials. The deploy helper reads only `deploy/.env` and the checked-in deploy template.

### Docker Desktop qualification note

During local qualification, Docker Desktop sometimes left CLI start requests waiting. Explicit starts restored the services, and the real web/authentication, isolated content hosts and restart persistence checks passed. Unattended `setup --up` on that Desktop installation is not fully qualified. Do not reset a Docker daemon that also hosts unrelated workloads. Public Linux-host deployment and DNS/ACME still need operator validation.
