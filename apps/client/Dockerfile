# apps/client — static site, built here and served by Caddy. Build context MUST
# be the repo root:
#   docker build -f apps/client/Dockerfile -t keysrun-client .
#
# Why a container for a static bundle at all: it keeps the client on the same
# Railway project (and the same `railway up` / GitHub-deploy pipeline) as api
# and sim, so there is one place to look when something is down. If/when the
# client moves to a CDN, this file and apps/client/Caddyfile are the only two
# things that get deleted — nothing in src/ depends on either.
#
# THE IMPORTANT PART: Vite inlines `import.meta.env.VITE_*` into the JS bundle
# at BUILD time (see apps/client/src/net/config.ts). The backend URLs are
# therefore compile-time inputs, not runtime config — a container built without
# them silently produces a bundle pointing at localhost that fails in
# production with a misleading "Could not reach the server" on the login form.
# Railway exposes a service's variables to the build as ARGs, which is why they
# are declared below rather than read at container start.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: pnpm needs every workspace member's package.json present to validate --------------
# the lockfile, even though only @keysrun/client and @keysrun/shared are built.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/sim/package.json apps/sim/package.json
COPY apps/client/package.json apps/client/package.json
# --filter "@keysrun/client..." scopes the install to client + its dependencies
# (shared) only. devDependencies are intentionally installed: the client's
# `build` script runs `tsc --noEmit` before vite, which needs the type packages.
RUN pnpm install --frozen-lockfile --filter "@keysrun/client..."

# ---- build ------------------------------------------------------------------------------------
FROM deps AS build
ARG VITE_API_URL
ARG VITE_SIM_WS_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SIM_WS_URL=$VITE_SIM_WS_URL
# Fail loudly here rather than shipping a bundle that falls back to localhost.
# config.ts's `?? 'http://localhost:8080'` default is correct for a developer
# running `pnpm dev`, but in a deployed image it is always a mistake, and one
# that is invisible until a real browser tries to log in.
RUN test -n "$VITE_API_URL" || { echo "ERROR: VITE_API_URL must be set at build time (Railway service variable)"; exit 1; }
RUN test -n "$VITE_SIM_WS_URL" || { echo "ERROR: VITE_SIM_WS_URL must be set at build time (Railway service variable)"; exit 1; }
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/client apps/client
# apps/client's own `prebuild` script already builds @keysrun/shared, but it is
# run explicitly here so a failure in shared is attributed to shared rather
# than surfacing as a confusing missing-types error inside the client's tsc.
RUN pnpm --filter @keysrun/shared run build
RUN pnpm --filter @keysrun/client run build

# ---- runtime ----------------------------------------------------------------------------------
FROM caddy:2-alpine AS runtime
ENV PORT=8080
COPY apps/client/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/client/dist /srv
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
