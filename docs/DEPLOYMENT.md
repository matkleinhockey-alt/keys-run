# Deployment

This is a step-by-step guide for deploying Keys Run, written for someone who
has never deployed anything before. If you already know Railway/Vercel, skip
to [Quick reference](#quick-reference) at the bottom.

Read `docs/ARCHITECTURE.md`'s "Deployment" section first — this document is
the click-by-click companion to it, not a replacement.

## The shape of it

Three things get deployed, to two platforms:

| what | where | how many | why |
|---|---|---|---|
| `apps/client` (the game, static files) | Vercel | N/A (static) | CDN-served, no server |
| `apps/api` (auth, leaderboard) | Railway | **2+ instances, horizontal** | stateless HTTP, safe to scale out |
| `apps/sim` (30 Hz world + WebSockets) | Railway | **exactly 1 instance, ever** | see the warning box below |
| Postgres | Railway (plugin) | 1 | shared by `api` and `sim` |

> ## ⚠️ `apps/sim` is a singleton. Do not raise its replica count.
>
> `apps/sim` holds the entire game world — every boat, every connection — in
> one process's memory. It is not a stateless web server. If you ever set its
> replica count above 1 (Railway calls this `numReplicas`), Railway will run
> **two independent copies of the world simultaneously**, each with its own
> players and its own state, and route WebSocket connections to whichever one
> a client happens to land on. There is no shared state between them. Players
> connected to different replicas will not see each other, boats will desync,
> and nothing will error — it will just silently be broken in a way that looks
> like a netcode bug for weeks.
>
> `apps/sim/railway.json` pins `deploy.numReplicas` to `1`. **If someone
> "fixes" sim capacity by bumping this, they have broken the game, not scaled
> it.** The correct way to give `sim` more headroom is a bigger instance (more
> vCPU/RAM on Railway's "Vertical Scaling" settings for that one service),
> per `docs/ARCHITECTURE.md`'s scaling ladder (4 → 8 → 16 vCPU). Horizontal
> scaling of the world only becomes possible after sharding is built
> (see `docs/ARCHITECTURE.md`, "Scaling ladder") — it does not exist yet.

## Prerequisites

- A GitHub account with this repo pushed to it (you already have this).
- A Railway account: https://railway.com — sign up with GitHub for the
  easiest repo connection.
- A Vercel account: https://vercel.com — same, sign up with GitHub.
- Node.js 20+ and `pnpm` installed locally if you want to run the CLI
  commands below (`corepack enable` will get you the right pnpm version from
  this repo's `package.json#packageManager`).

### The logins only you can do

I (the agent that wrote this) cannot authenticate interactively, so these two
commands are yours to run, from a local clone of this repo, when the
instructions below call for them:

```sh
railway login
```

This opens a browser window to authorize the Railway CLI. Run it once before
any `railway run` / `railway link` command below.

```sh
vercel login
```

Same idea for Vercel. You generally won't need the Vercel CLI at all — the
dashboard's GitHub integration handles builds — but it's useful for pulling
env vars locally (`vercel env pull`) if you ever need to debug a build.

Everything else below is clicking in the Railway and Vercel web dashboards,
which only you can do since it requires your logged-in session.

---

## Part 1: Railway — Postgres, `api`, `sim`

### 1.1 Create the project and add Postgres

1. Go to https://railway.com/new.
2. Click **"Deploy from GitHub repo"**. Authorize Railway's GitHub app if
   prompted, then select this repo (`keys-run`).
3. Railway will create a project and one service pointed at the repo. Leave
   it for now — you'll configure it as `api` in the next section (or delete
   it and create fresh services if you'd rather start clean; either works).
4. In the project canvas, click **"+ New"** → **"Database"** →
   **"Add PostgreSQL"**. This provisions a Postgres instance and a service
   for it in the same project, by default named `Postgres`.

### 1.2 Configure the `api` service

Click the service you want to use as `api` (rename it to `api` via its
Settings → the pencil icon next to the service name, so the project canvas
stays readable).

**Settings → Source:**
- **Root Directory:** leave this as `/` (the repo root). Do **not** set it to
  `apps/api`. This matters: `apps/api/Dockerfile` needs the whole monorepo
  (it copies `packages/shared` and runs a workspace-aware `pnpm install`), so
  Railway's build needs the full repo as its build context, not just the
  `apps/api` subfolder.
- **Config-as-code / Config File Path:** set this to `apps/api/railway.json`.
  (Railway's own docs put it this way: "the Railway Config File does not
  follow the Root Directory path" — you give it the full path from the repo
  root regardless of what Root Directory is set to.)
- **Branch:** pick whichever branch you want to deploy from (`main` is the
  usual choice for production; see the note on `integration` under CI below).

With that config file in place, Railway reads `apps/api/railway.json`, which
already specifies: build via `apps/api/Dockerfile`, health check `/health`,
2 replicas, a 10s deploy overlap/drain window, and a `preDeployCommand` that
runs the database migration automatically on every deploy (more on this in
1.4). You should not need to touch Settings → Build or Settings → Deploy
beyond what the config file already sets.

**Settings → Networking:**
- Click **"Generate Domain"**. This gives `api` a public URL like
  `api-production-xxxx.up.railway.app`. Copy it down — the Vercel client
  needs it, and so does the test in 1.5.

**Variables tab** — add these (click "+ New Variable" for each):

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Type this literally, including the `${{...}}`. Railway resolves it to the Postgres service's private-network connection string at deploy time. (If you named the Postgres service something other than `Postgres`, use that name instead.) Private, not public — `api` and `Postgres` talk over Railway's internal network, which is faster and doesn't count against any public bandwidth. |
| `NODE_ENV` | `production` | Switches off pino's pretty-printer and stops stack traces from leaking into error responses (see `apps/api/src/env.ts`). |
| `CORS_ORIGIN` | *(placeholder for now — see 2.4)* | The browser-enforced allowlist of origins that may call `/leaderboard`, `/me`, etc. Must be the Vercel client's URL. You don't have that URL yet (it's Part 2), so set this to `http://localhost:5173` for now and come back in step 2.4 to fix it before announcing this publicly. |

`PORT` is injected by Railway automatically — do not set it yourself.

### 1.3 Configure the `sim` service

Click **"+ New"** → **"GitHub Repo"** → select this same repo again. Railway
will add a second service in the same project pointed at the repo. Rename it
to `sim`.

**Settings → Source:**
- **Root Directory:** `/` (same reasoning as `api`).
- **Config File Path:** `apps/sim/railway.json`.

This config file sets: build via `apps/sim/Dockerfile`, health check
`/health`, **`numReplicas: 1`** (see the warning box above — do not change
this), `overlapSeconds: 0`, and **`drainingSeconds: 30`**.

**On that `drainingSeconds` value — read this part carefully:**

`apps/sim` implements the graceful shutdown sequence from
`docs/ARCHITECTURE.md`: on SIGTERM it flips `/health` to 503, broadcasts a
restart warning to connected players, stops the tick loop, and does one
batched write of every connected player's position to Postgres (measured at
under 500ms for 100 players) before actually closing WebSockets and exiting.

Railway's default grace period between SIGTERM and SIGKILL, **if you don't
set `drainingSeconds`, is 0 seconds.** Zero. Not "generous," not "a few
seconds" — Railway sends SIGTERM and SIGKILLs the process essentially
immediately after. None of the graceful-shutdown code above would ever run.
Every deploy would hard-kill the world process mid-tick, and every connected
player's position would silently revert to whatever their last 30-second
autosave captured (see `apps/sim/src/lifecycle.ts`'s `autosaveDirtyPlayers`)
— up to 30 seconds of lost progress, every single deploy, forever.

`apps/sim/railway.json` sets `drainingSeconds: 30`, which is generous
headroom over the measured sub-second shutdown time (locally, with zero
connected players, the full sequence completed in under 50ms; the doc's own
budget for 100 players is under 500ms). If you ever touch this file, do not
lower it below a few seconds, and do not remove it — removing the key makes
it fall back to Railway's platform default, which is 0.

**Settings → Networking:** click **"Generate Domain"**. Copy this URL too —
it's `VITE_SIM_WS_URL` for the client (as `wss://`, not `https://`).

**Variables tab:**

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Same Postgres, same reasoning as `api`. `sim` only reads/writes player resume state and catch rows — it never runs migrations itself (see `apps/sim/test/globalSetup.ts`'s doc comment). |
| `NODE_ENV` | `production` | Same as `api`. |

Do **not** set `TICK_HZ`, `SNAPSHOT_HZ`, `MAX_PLAYERS`, or `PORT` — they have
production-correct defaults baked into `apps/sim/src/constants.ts` /
`env.ts`, and `docs/ARCHITECTURE.md` explicitly says the tick rate is "not a
knob to fiddle with."

### 1.4 The first migration

`apps/api/railway.json` sets `deploy.preDeployCommand` to
`node dist/db/migrate.js`. This runs automatically, inside the already-built
deploy image, **before** every deploy starts serving traffic — including the
very first one. In plain terms: **you don't have to do anything extra for
the first migration.** Push to your connected branch, Railway builds the
image, runs the migration against `DATABASE_URL`, and only then starts `api`.

You can confirm it ran by opening the `api` service's **Deployments** tab,
clicking the active deployment, and checking the build/deploy logs for a line
like `Migrations applied to postgres://...`.

If you ever need to run it manually (e.g. to re-check status, or to run
`db:seed`), do it from your own machine against the real database:

```sh
railway login          # one-time, opens a browser
railway link           # pick this project when prompted
railway run pnpm db:migrate --filter @keysrun/api
```

`railway run` injects the linked service's environment variables (including
the real `DATABASE_URL`) into that one local command without ever putting
the production connection string in your shell history or a `.env` file.

### 1.5 Verify both services are actually up

```sh
curl https://<your-api-domain>.up.railway.app/health
# => {"status":"ok"}        (200). "unavailable" + 503 means the DB is unreachable.

curl https://<your-sim-domain>.up.railway.app/health
# => {"status":"ok","tickFresh":true,"tickFast":true,"dbLive":true,"tickAgeMs":<small int>}
```

For `sim`, `tickFresh`/`tickFast` false or a growing `tickAgeMs` means the 30
Hz loop has stalled or is running hot — see `docs/ARCHITECTURE.md`'s
"Degradation ladder." `dbLive: false` means it can't reach Postgres.

Also worth doing once: open the service's **Deployments** tab and confirm
the latest deployment shows a green **"Active"** status, not stuck on
**"Building"** or showing **"Crashed."**

---

## Part 2: Vercel — the client

### 2.1 Import the project

1. Go to https://vercel.com/new.
2. **"Import Git Repository"** → select this repo.
3. On the configuration screen:
   - **Root Directory:** leave as `./` (the repo root shown by default). Do
     **not** change it to `apps/client`. The committed root `vercel.json`
     already sets `installCommand`, `buildCommand`, and `outputDirectory` to
     do the right thing for a pnpm workspace where the app being built
     (`apps/client`) depends on a sibling workspace package
     (`packages/shared`):
     - install: `pnpm install --frozen-lockfile` (run at the repo root, which
       is required for pnpm to link workspace packages at all)
     - build: `pnpm --filter @keysrun/client run build` (this also builds
       `packages/shared` first automatically — see that app's own
       `prebuild` script)
     - output: `apps/client/dist`
   - **Framework Preset:** Vercel may show "Other" since the root directory
     isn't itself a Vite project — that's fine, the explicit `buildCommand`/
     `outputDirectory` above make the preset irrelevant.
4. **Environment Variables** (expand that section on the same screen, or add
   them later under Settings → Environment Variables):

   | Variable | Value | Why |
   |---|---|---|
   | `VITE_API_URL` | `https://<your-api-domain>.up.railway.app` | Base URL the client calls for auth/leaderboard. |
   | `VITE_SIM_WS_URL` | `wss://<your-sim-domain>.up.railway.app` | WebSocket URL for the world connection. Use `wss://`, not `ws://` — Railway terminates TLS at its edge. |

   > **Note for whoever wires up the networking client code:** as of this
   > commit, nothing in `apps/client/src` actually reads
   > `import.meta.env.VITE_API_URL` or `VITE_SIM_WS_URL` yet — there's no
   > networking client there to read them. This section, and
   > `apps/client/.env.example`, exist so the variable names and values are
   > already settled and sitting in both dashboards by the time that code
   > lands — it should need zero deploy-config changes, just
   > `import.meta.env.VITE_API_URL` calls in the source.

5. Click **Deploy**.

### 2.2 Verify

Open the deployment URL Vercel gives you. You should see `index.html` load
(check DevTools → Network: the hashed files under `/assets/*.js` /
`/assets/*.css` should return 200, not 404 — a 404 there usually means
`outputDirectory` is wrong). Check response headers on one of those asset
requests: `Cache-Control` should read `public, max-age=31536000, immutable`.
On `/` itself it should read `public, max-age=0, must-revalidate` — this
matters because `index.html` is the one file that must always be
revalidated (it's what points at the *current* hashed asset filenames); the
assets themselves are safe to cache forever precisely because their filename
changes whenever their content does.

### 2.3 Rollback

Project → **Deployments** tab → find a previous good deployment → its **⋯**
menu → **"Instant Rollback"**. Traffic re-points in about a second. To undo
the rollback later (once a real fix is deployed), go back to Deployments,
find the new deployment, **⋯** → **"Promote to Production."**

### 2.4 Close the loop on `CORS_ORIGIN`

Now that you have the real Vercel URL, go back to Railway's `api` service →
Variables → edit `CORS_ORIGIN` to the real value, e.g.:

```
https://keys-run.vercel.app
```

(Comma-separate multiple origins if you add a custom domain later —
`apps/api/src/env.ts` splits on `,`.) Saving the variable triggers a redeploy
of `api` automatically.

---

## Part 3: CI (GitHub Actions)

`.github/workflows/ci.yml` runs on every pull request and every push to
`integration` or `main`: install → build `packages/shared` → typecheck →
lint → build → `check:no-three` → test (against a real Postgres service
container, matching what `apps/api/src/test/globalSetup.ts` and
`apps/sim/test/globalSetup.ts` expect via `TEST_DATABASE_URL`).

This is independent of both Railway and Vercel — it doesn't deploy anything,
it's the gate that keeps `integration`/`main` buildable. Railway and Vercel
each run their **own** build (from the Dockerfiles / `vercel.json`
respectively) at deploy time regardless of CI; CI's job is to catch breakage
before it reaches a branch that triggers those.

**Which branch should Railway/Vercel deploy from?** Point both platforms'
"Production" branch at `main`. Treat `integration` as the branch where
feature branches land and CI gates them; promote `integration` → `main`
(merge or fast-forward) when you're ready to ship, which is what actually
triggers production deploys on both platforms.

---

## Rollback summary

| platform | where | action |
|---|---|---|
| Railway (`api` or `sim`) | service → Deployments tab → **⋯** on a prior deployment | **Rollback** (restores that deployment's image + variables) |
| Vercel (`client`) | project → Deployments tab → **⋯** on a prior deployment | **Instant Rollback** |

Railway rollback restores the Docker image *and* the variables as they were
at that deployment — if you've since changed a variable and need the old
code with the *current* variables instead, use **Redeploy** on the older
deployment instead of **Rollback**.

---

## Quick reference

### Env vars

| service | var | required | source |
|---|---|---|---|
| `api` | `DATABASE_URL` | yes | `${{Postgres.DATABASE_URL}}` |
| `api` | `CORS_ORIGIN` | yes | the Vercel client's URL(s), comma-separated |
| `api` | `NODE_ENV` | recommended | `production` |
| `api` | `PORT` | auto | set by Railway, do not override |
| `sim` | `DATABASE_URL` | yes | `${{Postgres.DATABASE_URL}}` |
| `sim` | `NODE_ENV` | recommended | `production` |
| `sim` | `PORT` | auto | set by Railway, do not override |
| `sim` | `TICK_HZ`/`SNAPSHOT_HZ`/`MAX_PLAYERS`/`AUTOSAVE_INTERVAL_MS` | no | leave at code defaults |
| client (Vercel) | `VITE_API_URL` | yes (once wired up) | `api`'s Railway domain, `https://` |
| client (Vercel) | `VITE_SIM_WS_URL` | yes (once wired up) | `sim`'s Railway domain, `wss://` |

### Local verification commands used while building this deploy config

These are the commands that were actually run against this repo to prove the
above works, in case something regresses later:

```sh
# full workspace, from a clean checkout
pnpm install --frozen-lockfile
pnpm run typecheck   # root "pretypecheck" builds packages/shared first
pnpm run lint
pnpm run build
pnpm run check:no-three
pnpm run test        # needs postgres running (docker compose up -d postgres)

# the two Docker images, built exactly as Railway would build them
# (context MUST be the repo root, not apps/api or apps/sim)
docker build -f apps/api/Dockerfile -t keysrun-api .
docker build -f apps/sim/Dockerfile -t keysrun-sim .

# the client static bundle
pnpm --filter @keysrun/client run build
npx serve -s apps/client/dist   # then open http://localhost:3000
```

### Singleton reminder

**`apps/sim`'s `numReplicas` must stay `1`.** See the warning box at the top
of this document.
