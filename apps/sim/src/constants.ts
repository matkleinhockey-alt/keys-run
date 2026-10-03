/**
 * Tunable constants for the sim loop, envelope validation and interest management. Centralized
 * here (rather than scattered as magic numbers) so tests and the load harness share exactly the
 * values the server runs with. See docs/ARCHITECTURE.md's Netcode / Interest management /
 * Authority model sections for the numbers this is translating into code.
 */

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
/** docs/ARCHITECTURE.md: "while (acc >= DT && steps < 5) { step(DT); acc -= DT }" */
export const MAX_STEPS_PER_FRAME = 5;

export const SNAPSHOT_HZ = 15;
/** Broadcast every Nth tick. 30/15 = 2. */
export const SNAPSHOT_TICKS = Math.round(TICK_HZ / SNAPSHOT_HZ);

/** 9-bit slot id space (see docs/ARCHITECTURE.md's "per-client 9-bit slot ids"). */
export const MAX_SLOT_ID = 511;

// --- Envelope validation (docs/ARCHITECTURE.md "Authority model" / "Envelope checks") --------

/** Speed cap headroom over hull top speed, before adding wave-surge margin. */
export const ENVELOPE_SPEED_HEADROOM = 1.12;
/**
 * Flat wave-surge margin added on top of the headroom-scaled hull top speed. ARCHITECTURE.md
 * says "speed <= hull top * 1.12 + wave surge" without pinning a number. Originally set to 3
 * m/s as a guess; test/load.ts's sustained-maneuver runs measured a *real*, legitimate
 * stepBoat client holding a sustained favorable wave-surf condition for several seconds,
 * climbing visibly past hull.top*1.12+3 (observed into the high 40s m/s on hulls topping out
 * in the mid-30s) before this was raised — i.e. "a big roller can push you several m/s for well
 * under a second" undersold how long a genuine surf can run. 12 m/s is still a guess, just a
 * measured-against one rather than an armchair one — flagged as a tunable for real-world
 * telemetry to replace, not a value derived from the doc.
 */
export const ENVELOPE_WAVE_SURGE_MARGIN_MS = 12;
/**
 * Slack multiplier applied to the physically-possible per-tick position delta. 1.5 (the
 * original guess) false-positived under test/load.ts's sustained runs — wave drift (`dvx`/`dvz`
 * in stepBoat, a second, slower-decaying displacement term separate from speed*dt) adds enough
 * extra per-tick displacement during a sustained surf that legitimate position deltas exceeded
 * it. Raised after measuring real false positives, same caveat as the wave-surge margin above.
 */
export const ENVELOPE_POS_DELTA_SLACK = 2.5;
/** Slack multiplier applied to the physically-possible per-tick speed delta (accel check). */
export const ENVELOPE_ACCEL_SLACK = 2;
/** Slack multiplier applied to the physically-possible per-tick turn-rate delta. */
export const ENVELOPE_TURN_RATE_SLACK = 1.5;
/** landH(x,z) must be <= this to be considered "not on land". */
export const ENVELOPE_MAX_LAND_H = 0.2;
/** depthAt(x,z) must be >= hull.draft - this to be considered "not aground". */
export const ENVELOPE_DRAFT_SLACK = 0.35;

/** Soft leash: inside this, trust the client's report verbatim and resync the shadow to it. */
export const LEASH_SOFT_M = 3;
/** Hard leash: beyond this, reject the report outright and correct from the shadow. */
export const LEASH_HARD_M = 12;
/** Between soft and hard leash: trust the report, but pull the shadow toward it at this rate. */
export const LEASH_PULL_RATE_PER_S = 0.5;

// --- Interest management (docs/ARCHITECTURE.md "Interest management") -----------------------

export const GRID_CELL_M = 64;

export const RADIUS_HOT_M = 30;
export const RADIUS_MID_M = 80;
export const RADIUS_FAR_M = 260;
/** Hysteresis: unsubscribe only beyond radius * this factor. */
export const UNSUBSCRIBE_FACTOR = 1.15;
/** Minimum time a subscription must live before it's allowed to drop (kills boundary flapping). */
export const MIN_DWELL_MS = 2000;
/** Fade-in the doc specifies for a newly-subscribed entity; tracked for the client, not enforced server-side. */
export const FADE_IN_MS = 400;

/** How often (Hz) each player's interest set is re-evaluated. Staggered across players by slot. */
export const INTEREST_EVAL_HZ = 4;
export const INTEREST_EVAL_TICKS = Math.max(1, Math.round(TICK_HZ / INTEREST_EVAL_HZ));

/** Broadcast tick modulo at which mid/far-tier entities are included (hot is every broadcast). */
export const MID_TIER_SNAPSHOT_DIVISOR = 2; // 15 Hz / 2 = 7.5 Hz
export const FAR_TIER_SNAPSHOT_DIVISOR = 4; // 15 Hz / 4 = 3.75 Hz

// --- Byte budget (docs/ARCHITECTURE.md "Budget: ~3-4 KB/s ... 10 KB/s design ... 25 KB/s hard cap") --

export const DESIGN_BYTES_PER_SEC = 10_000;
export const HARD_CAP_BYTES_PER_SEC = 25_000;
export const DESIGN_BYTES_PER_SNAPSHOT = Math.floor(DESIGN_BYTES_PER_SEC / SNAPSHOT_HZ);
export const HARD_CAP_BYTES_PER_SNAPSHOT = Math.floor(HARD_CAP_BYTES_PER_SEC / SNAPSHOT_HZ);

// --- Lifecycle ----------------------------------------------------------------------------

export const AUTOSAVE_INTERVAL_MS = 30_000;
/** docs/ARCHITECTURE.md's SIGTERM sequence step 2 default ETA, broadcast in SERVER_RESTART. */
export const SHUTDOWN_ETA_MS = 15_000;
/** Health check: tick must have run within this long, or /health reports unhealthy. */
export const HEALTH_MAX_TICK_AGE_MS = 2000;
/** Health check: tick p99 must be under this, or /health reports unhealthy (also the degradation-ladder trigger). */
export const HEALTH_MAX_TICK_P99_MS = 25;
