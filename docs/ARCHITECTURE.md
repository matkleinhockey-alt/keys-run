# Keys Run — Architecture

Read this before touching code. It is the single source of truth for how this
project is structured and why. Decisions here are settled; do not re-litigate
them in an implementation PR.

## What we are building

Keys Run is a three.js fishing game set in Marathon, Florida Keys. It currently
exists as one 4,212-line HTML file (preserved at `legacy/index.html`). We are
turning it into:

1. A real codebase — pnpm monorepo, Vite + TypeScript, three.js r186 ES modules.
2. **One persistent shared world** — authoritative Node server on Railway,
   50–100 concurrent players, accounts and a trustworthy leaderboard.
3. **An underwater world** — free-dive off the boat into a photoreal reef with
   five depth bands, and spearfish.

Quality bar: shippable on Steam.

## The most important fact

**This is a port, not a rewrite.** The expensive assets already exist:

- `depthAt(x,z)` / `landH(x,z)` are **pure closed-form functions** returning real
  bathymetry to 560 m. No three.js dependency. These become shared client/server code.
- 40 species with real biology, 49 creature visual specs, 5 parametric boats,
  30 real islands — all plain object literals, liftable verbatim.
- A 15-point buoyancy hull integrator that genuinely feels good.

Preserve these. Roughly 45% of the legacy file lifts with only type annotations added.

## Repository layout

```
keys-run/
├─ apps/
│  ├─ client/        Vite + TS + three.js r186        → Vercel
│  ├─ api/           auth, leaderboard reads, HTTP    → Railway (horizontal)
│  └─ sim/           30 Hz authoritative world + WS   → Railway (SINGLETON)
├─ packages/
│  └─ shared/        imported by all three
│     ├─ world/      chainZ, shoreInfo, depthAt, landH, zoneAt, offshoreF
│     ├─ waves/      WAVES table, waveHBase, waveSlope, SEA_STATES
│     ├─ rng/        xoshiro128**, hashCell(seed,cx,cz,salt), weightedPick
│     ├─ content/    SPECIES, VIS, SHAPE, BOATS, HULLS, ZONE_TABLE, locations
│     ├─ sim/        stepBoat, stepDiver, fight, fish, spear, constants
│     └─ proto/      message ids, bit codecs, quantization schema
├─ docs/
└─ legacy/index.html  the original single-file game, kept as reference build
```

### `packages/shared` must never import three.js

This is enforced in five layers, because transitive imports sneak in through
barrel files:

1. No `three` in its `package.json`, not even as a devDependency.
2. Its `tsconfig` sets `"lib": ["ES2022"]` with **no DOM lib** — `window`,
   `document` and `performance` fail to typecheck there.
3. ESLint `no-restricted-imports` bans `three`, `three/*`, and `../../client`.
4. **CI assertion**: build `apps/sim` with esbuild `--metafile` and fail if
   `three` appears anywhere in the module graph. This is the layer that works.
5. Subpath `exports` + `"sideEffects": false`; servers import
   `@keysrun/shared/world`, never the package root.

⚠ **Known landmine:** legacy `waveH` (line 442) calls `wakeH`, which reads
`wakeP` — an array of `THREE.Vector4`. **three.js is currently inside the most-
shared function in the codebase.** Split it: `waveHBase(x,z,t,amp)` is pure and
shared; `waveH = waveHBase + wakeH` stays client-only. The server uses
`waveHBase` only.

## Authority model — the two decisions everything follows from

**A. The boat is client-simulated. The diver is server-simulated.**

The 15-point buoyancy integrator is a stiff coupled oscillator (ω_heave ≈ 3.5
rad/s). Reproducing an oscillator's *phase* across two machines is the hardest
possible prediction target, and phase error shows up as the boat shuddering —
the worst-looking artifact available. Meanwhile pitch/roll/heave are
competitively worthless; nobody wins a leaderboard by faking their roll angle.

The diver is the opposite: trivial to simulate, no oscillator, and its position
directly gates what you may shoot.

| quantity | authority |
|---|---|
| boat x, z, heading, speed | client simulates; server validates an envelope |
| boat y, pitch, roll, vy, vp, vr | **client only. Never sent upstream, never corrected.** |
| diver everything | **server**, client predicts with input replay |
| anything touching the leaderboard | **server only** |

The server runs a cheap **2-DOF shadow model** per boat (x, z, h, speed) using
the same shared throttle-lag / trim-curve / turn-rate code, plus one
`waveSlope` call for surge — no buoyancy, no substeps. ~1 µs/player/tick.

Envelope checks per tick: speed ≤ hull top × 1.12 + wave surge, position delta,
acceleration, turn rate, `landH ≤ 0.2` (no driving on land), `depthAt ≥ draft −
0.35` (no running a 3-ft draft across the flats). Soft leash 3 m, hard leash
12 m — wakes from other boats legitimately push your hull by metres and the
server does not model wakes.

**B. The leaderboard is reachable only through server-generated catch rows.**

`species` and `weight` travel **server→client only**. There is no client→server
"I caught X" message anywhere in the protocol. Everything else is defence in
depth; this is structural.

⚠ Today `chooseFish()` (legacy line 2656) rolls species *and weight* with
`Math.random()` client-side, and `lbRecord()` (3229) writes it straight to the
board. The entire leaderboard is one line of JS away from being fabricated.
**Do not publicly promote the leaderboard until phase 3 lands.**

## Netcode

| loop | rate |
|---|---|
| server sim | **30 Hz fixed** (33.333 ms) — 20 Hz gives 50 ms quantization on a 25 m/s spear = 1.25 m of slop |
| snapshot | 15 Hz (every 2nd tick), per-player filtered |
| client input | 30 Hz, on a **timer accumulator — not rAF** (backgrounded tabs stop rAF) |
| client render | native, interpolating the accumulator remainder |

**Transport: raw `ws` + custom binary.** Not Colyseus (its Schema encodes
numbers as float32/varint; our fields want 9–13 bits, and it gives us nothing
for lag compensation or per-client priority scheduling). Not Socket.IO (3–5×
the bytes). WebRTC/UDP is **impossible on Railway** — its edge is an HTTP/TCP
proxy and does not route inbound UDP; moving to UDP later means moving the sim
process off Railway. Keep a `Transport` interface so that stays a one-file change.

Use `perMessageDeflate: false` (compressing 400-byte frames 15×/s is a CPU fire)
and `noDelay: true`.

**Delta against the client's last *acknowledged* baseline, never against the
previous packet.** TCP head-of-line blocking is unavoidable; this makes a
delayed packet cost one stale frame instead of a desync cascade.

Key byte savings: per-client 9-bit slot ids rather than global 16-bit ids;
immutable descriptors (species, name, model) sent once at spawn, never in
snapshots; **schools replicate as one record** (centroid + heading + memberSeed)
with member offsets generated deterministically on both sides.

Budget: **~3–4 KB/s per player steady state**, 10 KB/s design budget, 25 KB/s
hard cap enforced by a per-client byte-budget scheduler that drops lowest
priority records. Server egress at 100 players ≈ 400 KB/s.

### Remote entity motion
- **Boats: extrapolate.** They are near-constant-turn-rate bodies and we
  replicate speed + heading, so forward-extrapolating 100 ms is accurate to
  centimetres. Visual lag ~30 ms instead of 150 ms.
- **Fish: interpolate** with a 100 ms buffer. They change direction erratically;
  extrapolation produces visible overshoot-and-snap.

### Interest management
Sparse 64 m grid, `Map<int32, Set<entityId>>`. Re-evaluated at 4 Hz per player,
staggered. Radii: boats 260 m (plus a 600 m / 1 Hz coarse tier for large boats
planing — you can see someone running the Seven Mile Bridge from a mile out),
submerged divers 40 m, schools 200 m topside / 60 m submerged, tracked fish 35 m.

Ring rates inside the subscription: hot ≤30 m at 15 Hz, mid 30–80 m at 7.5 Hz,
far 80–260 m at 3.75 Hz, filled by a priority accumulator until the byte budget
runs out.

No popping: subscribe at R, unsubscribe at R × 1.15 with a 2 s minimum dwell
(kills boundary flapping), plus a 0.4 s fade-in. A 9 m boat at 260 m is ~3 px
anyway.

## Fish ownership — three tiers

> **A fish is catchable or spearable if and only if it is a tier-3 tracked
> entity.** No exceptions. Promotion is driven entirely by server-side
> proximity, so "spoof a hit on a fish I invented" is structurally impossible —
> the entity id does not exist on the server.

1. **Decoration** — client-only, deterministic from `hash(worldSeed, cell, timeBucket)`,
   zero bytes. Birds, baitfish, non-catchable rays/turtles/dolphins. Species with
   `catchable: false` have **no server representation at all**.
2. **Replicated schools** — server owns the centroid only (~26 B state, ~7 B/snapshot).
   Members are generated from `memberSeed` identically on both sides.
3. **Tracked fish** — promoted when a diver is within 45 m, a bobber/hooked line
   within 60 m, or the school is record-class. Real entity, own AI, 1.2 s position
   history ring for lag compensation. Demoted after 10 s with no diver within 60 m.

Cost at 100 players: ~1,700 tracked fish ≈ 10% of one core.

### Resident schools
Derive permanent schools from `hashCell(worldSeed, cx, cz, SALT_RESIDENT)` —
same species, same patch reef, every day, forever, computed on demand. This is
what makes the world *learnable* ("there's always a mutton school on that patch
reef at the 18 m line"), which is what makes spearfishing an activity rather
than a shooting gallery. Layer a smaller set of simulated roamers on top.

⚠ The legacy `managePopulation` ring-spawns around the local boat with
`Math.random()` and frees beyond `POP_R+40`. In a shared world that is doubly
broken — two players at Sombrero Reef would see different fish, and turning
around re-rolls the reef. Replace with density-driven spawning over the union
of all players' radii, plus a 60 s dormant list so turning around does not
regenerate the world.

## Spearfishing

**Server-simulated projectile, not hitscan with rewind.** Hitscan would test
against the fish's position at fire time, making the correct play "aim directly
at a moving fish" rather than leading it — wrong for a speargun. Instead the
server spawns an authoritative spear at the **rewound** origin/direction and
integrates it forward at 25 m/s for ≤11 m, testing against **current** fish
positions each tick. Leading works naturally.

Rewind uses the **server's own measured RTT**, never the client's claim, capped
at 400 ms.

Envelope on every shot:

| control | value |
|---|---|
| fire rate | 1 per load, 2.5 s reload, hard floor 1 / 1.6 s |
| max range | 11 m (projectile lifetime) |
| **aim plausibility** | fire direction within **0.22 rad** of the interpolated *replicated* aim at rewind tick |
| origin | within 0.6 m of the rewound diver position |
| breath | cannot fire at `breath <= 0` |

Aim plausibility is the strongest anti-aimbot control available: aim is already
replicated at ≥15 Hz, so a snap-aimbot fails unless it smoothly streams fake aim
for ≥2 ticks beforehand — which makes it visible to nearby players.

## Rod fishing, server-authoritative

| step | client may assert | server decides |
|---|---|---|
| cast | `CAST_REQ {charge, aimYaw}` | bobber landing point (shared `castDistance`), zone, hotspot membership, bite timer |
| nibble | — | sends only a **silhouette size bucket** — not species, not weight (preserves the existing progressive reveal, which turns out to be an anti-cheat asset) |
| strike | `STRIKE {clientTick}` | checks against its own bite window + rtt/2 + 60 ms. **On hook, rolls species and weight with the server RNG.** |
| fight | `INPUT {reeling}` | runs the **entire fight integrator** server-side (~20 flops/player/tick) |
| land | nothing | emits `CATCH {species, weight, …}`, writes the row, updates records |

**The tension bar must not be predicted.** It *is* the minigame and it is the
exploit surface. At 80 ms RTT the bar lags 40 ms against time constants of
0.3–2.6 s — imperceptible.

Sanity envelopes: 1 cast / 0.4 s, max 120 landed fish/player/hour, and a
**minimum fight duration** of `0.8 + (weight/species.max) × species.str × 6`
seconds — a 400 lb marlin landed in 4 s voids the catch. Also run a per-player
KS test of landed weights against the distribution the server knows it sampled;
this catches exploits nobody anticipated.

## Determinism

`+ − × ÷ sqrt` are IEEE-754 exact everywhere. `Math.sin/cos/pow/exp` are **not**
bit-identical across V8 versions and architectures, and the wave sum uses 8 sin
+ 8 cos per call.

By construction this almost never matters — there is no lockstep, and prediction
compares with tolerances (2 cm diver, 3 m boat). The one real risk is
**procedural acceptance tests near a threshold**: `if (depthAt(x,z) < 3) continue`
evaluated on two machines can disagree, and a piling that exists on the server
but not the client is a boat that stops for no reason.

> **The rule: gameplay-relevant placement is computed once on the server and
> shipped to the client as a versioned table. Cosmetic placement is computed
> client-side from the shared seed.**

Shipped tables: piling positions, dock rects, hotspots, resident schools, rig
legs. A few hundred KB, fetched once, cached by `worldSeed + contentVersion`.

### Seeding
Keep the existing `srand()` Lehmer generator with `seed=11` **exactly as-is for
island placement** so the island layout does not move. Replace every other
placement `Math.random()` with `hashCell(WORLD_SEED, cellX, cellZ, salt)` —
**position-derived, not iteration-order-derived**. This distinction is critical:
with iteration-order RNG, adding one building shifts every later object in the
world; with cell-hash RNG, placement is stable under code changes and computable
on demand in any order.

The rejection-sampling loops (legacy `place()`/`fits()`, lines 856–868) are
genuinely order-dependent and need restructuring, not a find-and-replace.

## Deployment

### Railway — two services from day one

| service | scaling | contents |
|---|---|---|
| `api` | horizontal, redeployable anytime | auth (argon2id), leaderboard reads, world tables |
| `sim` | **singleton, vertical only** | the 30 Hz loop + WebSockets |

Split immediately. `api` redeploys without disconnecting players, and a
leaderboard traffic spike cannot stall the tick loop. Critically, **argon2id
takes 50–100 ms**, which would eat three ticks — it must never run in `sim`.

Sizing: 4 vCPU / 8 GB for `sim`. Game state is < 20 MB; **CPU headroom is what
you are buying, not memory.**

**GC discipline is a real risk at 30 Hz** — a 50 ms major GC is 1.5 dropped
ticks for everyone on the shard. Structure-of-arrays typed arrays for entity
state, preallocated snapshot buffers, no closures in the tick loop. Target
**zero allocation in the steady-state tick.**

### Graceful shutdown (non-negotiable)

Railway restarts the process on every deploy.

```
SIGTERM:
  1. /health/ready -> 503
  2. broadcast SERVER_RESTART{etaMs:15000}
  3. resolve in-flight fights: in the safe band -> LAND and write; else release
  4. one batched upsert of all connected players (< 500 ms for 100)
  5. write resume tokens
  6. close with code 4001, drain, exit(0)
```

> Award the fish on a deploy-time shutdown. A player losing a record marlin to
> *your* deploy is unforgivable; a free fish is forgettable.

**Do not rely on SIGTERM alone** — autosave dirty players every 30 s and write
immediately on every catch, so a SIGKILL costs 30 s of boat position.

### Reconnect-and-resume
32-byte session token, 10 min expiry, `resume jsonb`. Reconnect with exponential
backoff + jitter, retry forever. **The analytic world is a major asset here** —
there are no assets to reload, so the client keeps rendering throughout, freezes
remote entities, and resumes in 8–20 s with no loading screen.

### Scaling ladder
Vertical (4 → 8 → 16 vCPU, good to several hundred), then **multiple whole-world
instances with a shared global leaderboard**. Geographic sharding probably never
— splitting an 8.3 km world defeats the entire premise. But build four cheap
seams now: entity ids as `(shardId << 24) | localId`, a `WorldIndex` interface
carrying its own bounds, a `Gateway` that returns `{shardWsUrl, shardId}`, and
boundary rectangles defined as data.

### Degradation ladder (decide now, not during an incident)
When tick p99 > 33 ms: (1) far ring to 1 Hz, (2) halve tracked-fish promotion
radius, (3) demote tier-3 fish with no diver within 25 m, (4) sim to 20 Hz
(broadcast so clients match), (5) refuse new connections.

## The underwater world

Depth bands map onto bathymetry that **already exists** in `depthAt`. The reef
wall sits at `dz` 1460–1650 — only 190 m wide, dropping 3.4 m → 45.4 m — so a
player swims through every band in one dive. That is the money location.

| band | depth | vis | biome | mechanic |
|---|---|---|---|---|
| 1 | 0–5 m | 30 m | seagrass flats, sand | no pressure penalty |
| 2 | 5–10 m | 25 m | patch reef — **reds are gone** | 2 ATA, air drains 2× |
| 3 | 10–15 m | 20 m | reef wall top, elkhorn/staghorn | neutral buoyancy ~10–12 m |
| 4 | 15–20 m | 15 m | ledges, overhangs, swim-throughs | 3 ATA, narcosis shimmer |
| 5 | 20 m+ | 10 m | deep wall, wrecks, the Humps | torch required, blackout risk |

Three real Marathon dive sites are **already in the game's data** as `HUMPS`
entries: Sombrero Reef, Coffins Patch, Delta Shoal. Add the Thunderbolt wreck
(a real 188-ft wreck in 120 ft off Marathon) as the band-5 set piece.

### Freedive physics — this is the gameplay
- Breath-hold ~90 s at surface, consumed at `ATA = 1 + depth/10`. At 20 m you
  burn air **3× faster**, so depth is self-limiting with no artificial gate.
- **Buoyancy inverts**: positive 0–10 m (you kick down), neutral ~10–12 m,
  negative below (freefall). Descending gets easier exactly as returning gets
  more expensive. That asymmetry is the entire tension of freediving, free.
- Blackout at zero air: lose the fish and the trip, **recover the gear** (gear
  loss reads as punishment, not tension).

### Rendering
The effect that sells it is **per-channel extinction** — water eats red first:

```
transmittance(rgb) = exp(−k_rgb × (distToCamera + cameraDepth))
k_red ≈ 0.45/m   k_green ≈ 0.09/m   k_blue ≈ 0.03/m
```

Implement by **globally overriding `THREE.ShaderChunk.fog_fragment`** so every
material — coral, fish, hulls, terrain — gets depth-correct attenuation without
being touched individually.

Then: caustics (projected, world-space XZ, gone by 20 m), god rays, marine snow,
and **Snell's window** — looking up, the sky compresses into a ~96° cone with
total internal reflection outside it. This requires the water plane to become
`DoubleSide`; it is currently `FrontSide`, **which is literally why there is no
underwater today.**

The ~200 ms crossing y=0 is the most important moment in the game: audio lowpass
crossfade, lens wetting, fog blended over 0.3 s, FOV narrowed to 0.75×.

### Seafloor
⚠ `floorY = d => -(0.25 + Math.min(d,14) × 0.55)` crushes every depth past 14 m
to y ≈ −7.95, and the mesh is one 90k-vertex plane at 28.6 m per vertex. It
becomes identity (`d => -d`) over chunked LOD terrain. **Only 6 call sites**:
legacy lines 708, 718, 934, 2103, 2563, 2574–2576.

### Reef
50 m chunks, per-coral-type `InstancedMesh` with per-instance transform/colour,
placed deterministically from `hashCell` so every player sees the same reef with
zero network traffic. Underwater draw distance is ~25 m, so only a 5×5
neighbourhood is ever resident.

### Fish at realism *and* density
1. **Hero** (near, targetable) — skinned glTF.
2. **School** — **vertex animation textures**: bake the swim cycle into a
   texture, render the whole school as one `InstancedMesh` with per-instance
   animation phase. This is what makes dense realistic schools possible at all.
3. **Ambient** — existing `SHAPE`-driven procedural geometry, PBR materials.

## Art direction

**Realism, concentrated underwater.** Underwater visibility is 10–25 m, so fog
culls almost everything — you can afford dense high-detail geometry precisely
because you can only ever see 20 m of it. Topside renders to a 1,900 m horizon
where the same approach is a GPU catastrophe, so topside keeps its procedural
geometry and gains PBR materials, modern colour management and better water.

Assets: licensed packs, normalised to glTF 2.0 through `@gltf-transform/cli`,
**KTX2/Basis** textures, **meshopt** geometry. Served from CDN, never bundled.
**Commit a licence manifest** recording source and commercial-use rights for
every pack — this matters for Steam and is miserable to reconstruct later.

### Performance budget (enforced, with a profiler HUD)
60 fps on an M1 Air / GTX 1650 · < 400 draw calls topside, < 300 underwater ·
< 2.5 M triangles · < 512 MB texture memory · < 15 MB before playable.

Existing hazards to fix en route: 60 cloud `Group`s that should be one
`InstancedMesh` (~270 needless draw calls); `makeBoat` creating fresh materials
per call (every joining player instantiates one); `depthAt` on hot paths where
`depthFast` exists; 5.9 MB `DEPTHG`/`INLETG` allocated at boot.

## Phase order

Phase 0 is load-bearing for everything and is also the least glamorous. Do not
skip ahead.

| phase | scope | gate |
|---|---|---|
| **0** | monorepo; extract `shared`; split `waveH`/`wakeH`; seed placement RNG; fixed 30 Hz boat step; split sim from presentation. **Still single-player.** | feel is indistinguishable from legacy, verified against recorded input traces |
| **1** | `api`, auth, Postgres, leaderboard tables. **No catch-write endpoint, ever** — catches reach the DB only via the sim service (phase 3) or seed/test fixtures | — |
| **2** | `sim`: 30 Hz loop, interest grid, boat replication | it is a shared world of boats |
| **3** | **server-authoritative rod fishing**; delete client `chooseFish` | leaderboard becomes trustworthy — do not promote it before this |
| **4** | fish tiering, resident schools | — |
| **5** | diver, free-dive, spearfishing with lag compensation | — |
| **6** | hardening: degradation ladder, metrics, resume, behavioral anti-cheat | — |

## Conventions

- TypeScript strict. No `any` in `packages/shared`.
- `packages/shared` is pure: no DOM, no three.js, no `Date.now()` in simulation
  paths (pass tick/time in), no module-level side effects.
- Simulation functions are `step*(state, input, dt) → state` with plain
  `{x,y,z}` objects — **never `THREE.Vector3`**.
- Presentation is separate: `applyBoatVisuals(state, model, dt)` lives client-side.
- Vitest for `packages/shared`. Playwright for client smoke tests.
- Conventional commits.
