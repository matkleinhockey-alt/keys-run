/**
 * Drizzle schema for the api service's Postgres database.
 *
 * Table list and required indexes come from docs/ARCHITECTURE.md Phase 1
 * ("api, auth, Postgres, leaderboard tables — still client-written, just to
 * settle schema") plus the task brief: users, sessions, players, catches,
 * species_records, global_records, world, audit_flags.
 *
 * Money/weight convention: weights are `numeric(7,2)` lb (max 99999.99,
 * comfortably above the heaviest species max of 900 lb bluefin/black marlin
 * in packages/shared/src/content/species.ts) stored as exact decimal, never
 * float — this feeds a public leaderboard and float drift on repeated
 * aggregate queries is not acceptable.
 *
 * See the inline comments on `players`, `globalRecords` and `speciesRecords`
 * for schema decisions that go beyond what ARCHITECTURE.md specifies
 * verbatim (it names the tables but not their columns) — summarized again in
 * the Phase 1 handoff report.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  bigint,
  index,
  uniqueIndex,
  real,
  serial,
  boolean,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Case-insensitive uniqueness: "a@b.com" and "A@b.com" are the same account.
  uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
  uniqueIndex('users_display_name_lower_idx').on(sql`lower(${t.displayName})`),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // sha256(raw 32-byte token), hex-encoded. The raw token is returned to the
  // client exactly once (at login) and never stored — only this hash is.
  tokenHash: text('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
  index('sessions_user_id_idx').on(t.userId),
]);

/**
 * One row per user: persistent player-side state that isn't auth.
 *
 * ARCHITECTURE.md names this table but does not give its columns. Phase 1 has
 * no sim yet, so there is no live boat/diver position to store — `resume`
 * is reserved jsonb for Phase 2+ (see "Reconnect-and-resume": the sim writes
 * a resume blob here so a reconnecting player resumes without a loading
 * screen). Kept deliberately thin rather than guessing at fields the sim
 * doesn't exist to produce yet.
 */
export const players = pgTable('players', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  resume: jsonb('resume').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only ledger of landed fish. Originally server-written only — see
 * ARCHITECTURE.md "The leaderboard is reachable only through server-generated
 * catch rows" — with writers limited to apps/api/src/db/seed.ts and test
 * fixtures.
 *
 * `routes/catches.ts` now also writes here, from an authenticated client
 * POST. Read that route's doc comment for the full honesty tradeoff: it is a
 * deliberate interim step short of real server authority (which needs the
 * sim to own the fight, phase 3), not a quiet reversal of the rule above.
 *
 * `suspicion` is a per-catch anti-cheat score — currently populated by
 * routes/catches.ts's species/weight-range check (lib/catch-validation.ts),
 * with Phase 3+ expected to add the KS-test / fight-duration checks
 * ARCHITECTURE.md describes under "Rod fishing, server-authoritative". A
 * `suspicion > 0` row is still written (this ledger is append-only, so the
 * board can always be rebuilt) but is excluded from `global_records`/
 * `species_records` by `lib/records.ts`'s `recordCatch` — the partial index
 * below lets ops tooling scan flagged catches without touching the (much
 * larger) clean set.
 */
export const catches = pgTable('catches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  speciesKey: text('species_key').notNull(),
  weightLb: numeric('weight_lb', { precision: 7, scale: 2 }).notNull(),
  caughtAt: timestamp('caught_at', { withTimezone: true }).notNull().defaultNow(),
  suspicion: real('suspicion').notNull().default(0),
}, (t) => [
  index('catches_user_id_caught_at_idx').on(t.userId, t.caughtAt.desc()),
  index('catches_species_key_weight_lb_idx').on(t.speciesKey, t.weightLb.desc()),
  index('catches_suspicion_idx').on(t.suspicion).where(sql`${t.suspicion} > 0`),
]);

/**
 * Global leaderboard, one row per user holding their single best-ever catch
 * (any species) plus their total landed-fish count. This is the
 * "top_overall" table the brief refers to — `/leaderboard/overall` reads
 * this directly (ORDER BY weight_lb DESC LIMIT 100), never `catches`.
 * Maintained incrementally by apps/api/src/lib/records.ts's `recordCatch`
 * whenever a non-suspicious catch row is written (seed/tests, or
 * routes/catches.ts's authenticated client POST — see that route's doc
 * comment). A `suspicion > 0` catch is deliberately skipped here.
 */
export const globalRecords = pgTable('global_records', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  catchId: uuid('catch_id').notNull().references(() => catches.id),
  speciesKey: text('species_key').notNull(),
  weightLb: numeric('weight_lb', { precision: 7, scale: 2 }).notNull(),
  catchCount: integer('catch_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('global_records_weight_lb_idx').on(t.weightLb.desc()),
]);

/**
 * Per-species leaderboard, one row per species key (40 rows — see
 * packages/shared/src/content/species.ts). `/leaderboard/species` reads this
 * directly instead of a GROUP BY over `catches`.
 */
export const speciesRecords = pgTable('species_records', {
  speciesKey: text('species_key').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  catchId: uuid('catch_id').notNull().references(() => catches.id),
  weightLb: numeric('weight_lb', { precision: 7, scale: 2 }).notNull(),
  caughtAt: timestamp('caught_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Singleton row describing the authoritative world: the placement seed
 * (ARCHITECTURE.md "Seeding" — `seed=11` for the Lehmer `srand` that lays out
 * islands) and a content version that increments whenever a shipped
 * placement table (pilings, docks, hotspots, resident schools — see
 * "Determinism") changes shape, so clients can cache by `worldSeed +
 * contentVersion` as the doc specifies.
 */
export const world = pgTable('world', {
  id: integer('id').primaryKey().default(1),
  seed: bigint('seed', { mode: 'number' }).notNull(),
  contentVersion: integer('content_version').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Anti-cheat flags, coarser-grained than per-catch `suspicion`: rate-limit
 * trips, KS-test failures accumulated over a session, impossible fight
 * durations, etc. `catchId` is nullable because not every flag is tied to one
 * catch (e.g. a cast-rate violation).
 */
export const auditFlags = pgTable('audit_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  catchId: uuid('catch_id').references(() => catches.id),
  reason: text('reason').notNull(),
  severity: integer('severity').notNull().default(1),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  index('audit_flags_user_id_idx').on(t.userId),
]);

/**
 * Tag-and-release registry: one row per tagged individual fish, shared by
 * every player. `weight_lb`/`x`/`z`/`last_seen_at` are where and how big it
 * was the last time anyone had it in hand; its weight *now* is derived on
 * read from that plus elapsed time (packages/shared/src/sim/tagging.ts's
 * `grownWeight`), so nothing has to tick the table.
 *
 * Same honesty caveat as `catches` (routes/catches.ts): tagging is a client
 * assertion. The recapture route never takes a client weight, though — a
 * recaptured fish's weight is always the server's grown value.
 */
export const taggedFish = pgTable('tagged_fish', {
  id: uuid('id').primaryKey().defaultRandom(),
  tagNo: serial('tag_no').notNull(),
  speciesKey: text('species_key').notNull(),
  weightLb: numeric('weight_lb', { precision: 7, scale: 2 }).notNull(),
  x: real('x').notNull(),
  z: real('z').notNull(),
  status: text('status').notNull().default('at_large'),
  taggedBy: uuid('tagged_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('tagged_fish_tag_no_idx').on(t.tagNo),
  index('tagged_fish_species_at_large_idx').on(t.speciesKey).where(sql`${t.status} = 'at_large'`),
]);

/** Append-only life history of a tagged fish: the tagging, then every time
 * someone landed it (released again, or harvested — which retires the tag). */
export const tagEvents = pgTable('tag_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  tagId: uuid('tag_id').notNull().references(() => taggedFish.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  weightLb: numeric('weight_lb', { precision: 7, scale: 2 }).notNull(),
  x: real('x').notNull(),
  z: real('z').notNull(),
  zone: text('zone').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('tag_events_tag_id_at_idx').on(t.tagId, t.at),
]);

/**
 * Keys Run Estates: who owns which shore lot, and what they built on it. The parcels themselves
 * (polygons, tiers, prices) are fixed data in packages/shared/src/content/estates-plat.ts, keyed by
 * `parcel_id`; a lot with no row here is for sale (or a founding lot nobody has built on yet).
 * The primary key is the whole "one owner per lot" rule: two buyers racing for a lot is an insert
 * conflict, not a check-then-write.
 */
export const estates = pgTable('estates', {
  parcelId: text('parcel_id').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** What was paid (0 for a founding lot), from the price table at the time of sale. */
  price: integer('price').notNull(),
  founding: boolean('founding').notNull().default(false),
  build: jsonb('build').notNull(),
  boughtAt: timestamp('bought_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('estates_owner_id_idx').on(t.ownerId),
]);

/**
 * Each account's game save: the client's own state blobs (wallet and boats, gear and wardrobe,
 * casino, services, looted and charted wrecks — apps/client/src/net/cloud-save.ts lists them),
 * stored as the client wrote them so a signed-in player has the same game on any browser. Like the
 * wallet itself this is the client's word, not a server-validated ledger (routes/save.ts).
 */
export const playerSaves = pgTable('player_saves', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** { [localStorage key]: the JSON string stored under it }. */
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
