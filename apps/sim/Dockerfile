# apps/sim — Railway service, SINGLETON. See docs/ARCHITECTURE.md ("Deployment"):
# this is the 30 Hz authoritative world + WebSockets. Exactly one instance may run
# at a time — replicas would each simulate their own disconnected world. Scale this
# service VERTICALLY ONLY (more vCPU/RAM on the one instance), never by raising
# replica count. See apps/sim/railway.json and docs/DEPLOYMENT.md.
#
# Multi-stage, pnpm-workspace-aware build. Build context MUST be the repo root:
#   docker build -f apps/sim/Dockerfile -t keysrun-sim .
#
# Unlike apps/api, nothing here needs a native addon (no argon2 — this process
# must never run argon2's 50-100ms hash in the 30 Hz tick loop), so no C toolchain
# is installed.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace (pnpm needs every member's package.json) -------------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/sim/package.json apps/sim/package.json
COPY apps/client/package.json apps/client/package.json
# --filter "@keysrun/sim..." scopes the install to sim + its dependencies (shared)
# only — this is what keeps apps/api's argon2 native addon (and its C toolchain
# requirement) out of this image entirely, not just unused at runtime.
RUN pnpm install --frozen-lockfile --filter "@keysrun/sim..."

# ---- build: compile packages/shared, then apps/sim, then produce a self-contained ----------
# deploy directory (dist + pruned production node_modules) via `pnpm deploy`.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/sim apps/sim
RUN pnpm --filter @keysrun/shared run build
RUN pnpm --filter @keysrun/sim run build
RUN pnpm --filter @keysrun/sim deploy --prod --no-optional /app/out

# ---- runtime: small final image ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8081
WORKDIR /app
COPY --from=build /app/out ./
USER node
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "dist/index.js"]
