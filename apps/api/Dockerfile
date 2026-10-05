# apps/api — Railway service, horizontally scaled (safe to run N replicas).
# Multi-stage, pnpm-workspace-aware build. See docs/ARCHITECTURE.md ("Deployment")
# and docs/DEPLOYMENT.md. Build context MUST be the repo root:
#   docker build -f apps/api/Dockerfile -t keysrun-api .
#
# This process never runs argon2's hashing in the hot path of the sim loop —
# that's the whole reason api/sim are split — but it DOES depend on the
# `argon2` npm package, which ships a native addon. Alpine uses musl libc, so
# the addon is compiled from source in the `deps` stage (python3/make/g++)
# rather than relying on a prebuilt glibc binary; the resulting .node binary
# is then carried forward into the musl `runtime` stage unchanged.

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: install the full workspace. pnpm needs every workspace member's -----------------
# package.json present to validate the lockfile, even though only @keysrun/api and
# @keysrun/shared are actually built below.
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/sim/package.json apps/sim/package.json
COPY apps/client/package.json apps/client/package.json
# --filter "@keysrun/api..." scopes the install to api + its dependencies (shared)
# only, so apps/sim and apps/client's dependencies are never installed here.
RUN pnpm install --frozen-lockfile --filter "@keysrun/api..."

# ---- build: compile packages/shared, then apps/api, then produce a self-contained ----------
# deploy directory (dist + pruned production node_modules, @keysrun/shared included)
# via `pnpm deploy`, which resolves the workspace:* dependency into real files rather
# than a symlink — see docs/DEPLOYMENT.md for why this matters in a container.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @keysrun/shared run build
RUN pnpm --filter @keysrun/api run build
RUN pnpm --filter @keysrun/api deploy --prod --no-optional /app/out

# ---- runtime: small final image, no build toolchain, no devDependencies, no other apps -----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=build /app/out ./
# apps/api/src/db/migrate.ts resolves its migrations folder as 4 directories
# up from its own compiled location (correct for the normal apps/api/dist/db
# nesting inside the monorepo). `pnpm deploy` flattens apps/api's own content
# to the deploy root, so dist/db ends up only 2 levels under /app — the same
# "4 up" math then lands at the container's filesystem root, not /app. Rather
# than touch apps/api/src (out of this change's scope), place the migrations
# where that existing math actually looks for them: /infra/migrations.
COPY infra/migrations /infra/migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
# Migrate, then serve. railway.json declares the same thing as a
# `preDeployCommand`, but that is only honoured when Railway resolves this
# service's config-as-code — a `railway up` with an explicitly-set
# RAILWAY_DOCKERFILE_PATH does not, and the first production deploy then came up
# against a completely empty database (every query 500'd on a missing table).
# Running it here makes the container self-migrating however it was deployed.
# drizzle-kit migrations are idempotent, so this is a no-op on an up-to-date DB.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
