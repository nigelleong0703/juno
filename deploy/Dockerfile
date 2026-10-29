# Juno server image: backend services + built web app served same-origin by
# the api (WEB_DIST=/app/web-dist). Build context is the REPO ROOT:
#   docker build -f deploy/Dockerfile -t juno:latest .
# One image, three runtime roles (see deploy/compose.yml):
#   migrate: one-shot DB migrations (packages/db/src/migrate.ts)
#   app:     supervisor (deploy/supervise.mjs) running api + agentd +
#            computerd on the container loopback (agentd/computerd listen on
#            127.0.0.1 by product design; only the api binds 0.0.0.0 via
#            API_HOST so the edge proxy can reach it). No product source is
#            changed for deployment; entry points are the same production
#            wirings local dev uses (node --import tsx src/main.ts).

# ---- build: frozen deps + real web bundle --------------------------------
FROM node:26-bookworm-slim AS build
RUN npm install --global pnpm@12.9.1
WORKDIR /app
# Root workspace unifies backend/ + frontend/ (root pnpm-workspace.yaml +
# root pnpm-lock.yaml). Frozen install: release builds never resolve ad hoc.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY deploy ./deploy
RUN pnpm install --frozen-lockfile
# Real web build: the same bundle the release pin verifies
# (pnpm --filter @agent-desktop/web build -> frontend/packages/web/dist).
RUN pnpm --filter @agent-desktop/web build
RUN node -e "const fs=require('fs');const d='/app/frontend/packages/web/dist/index.html';if(!fs.existsSync(d)){console.error('web dist missing: '+d);process.exit(1)};console.log('web dist ok')"

# ---- runtime --------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
RUN npm install --global pnpm@12.9.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Docker CLI for COMPUTER_PROVIDER=local (the driver shells out to it; the
# daemon socket is mounted explicitly via deploy/compose.local-sandbox.yml).
# Copying the static CLI avoids the full docker apt repo.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app/backend
COPY --chown=node:node --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/
COPY --chown=node:node --from=build /app/backend ./
COPY --chown=node:node --from=build /app/node_modules /app/node_modules
COPY --chown=node:node --from=build /app/frontend/packages/web/dist /app/web-dist
COPY --chown=node:node --from=build /app/deploy /app/deploy
RUN mkdir -p /data && chown node:node /app /data
ENV WEB_DIST=/app/web-dist
ENV NODE_ENV=production
EXPOSE 8787 8788 8791 8795
# Default role is the app supervisor; compose overrides per service (migrate).
CMD ["node", "/app/deploy/supervise.mjs"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
USER node
