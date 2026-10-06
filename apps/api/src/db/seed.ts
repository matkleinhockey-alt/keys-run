/**
 * `pnpm db:seed` — idempotent local-dev seed. Inserts:
 *  - the singleton `world` row (placement seed + content version — see
 *    docs/ARCHITECTURE.md "Seeding": `seed=11` is the legacy Lehmer `srand`
 *    seed kept exactly as-is so island placement does not move).
 *  - a couple of local test users, with a handful of catches each so
 *    /leaderboard/* and /players/:id/records have something to read.
 *
 * This calls recordCatch() directly, same as test fixtures do — the one
 * other caller is routes/catches.ts's authenticated POST /catches, which
 * is the normal way a catch is written outside of seeding/tests. See that
 * route's doc comment for the honesty tradeoff docs/ARCHITECTURE.md's "the
 * leaderboard is reachable only through server-generated catch rows" now
 * carries as a deliberate, documented interim step.
 */
import { eq } from 'drizzle-orm';
import { SPECIES } from '@keysrun/shared/content/species';
import { loadEnv } from '../env.js';
import { createDb } from './client.js';
import { users, players, world } from './schema.js';
import { hashPassword } from '../lib/auth.js';
import { recordCatch } from '../lib/records.js';

const WORLD_SEED = 11; // legacy srand() seed — island placement must not move.
const CONTENT_VERSION = 1;

interface SeedUser {
  email: string;
  password: string;
  displayName: string;
  catches: Array<{ speciesKey: string; weightLb: number }>;
}

const SPECIES_KEYS = Object.keys(SPECIES);

const SEED_USERS: SeedUser[] = [
  {
    email: 'angler1@keysrun.test',
    password: 'keysrun-dev-pw-1',
    displayName: 'Captain Ahab',
    catches: [
      { speciesKey: 'tarpon', weightLb: 142.5 },
      { speciesKey: 'mahi', weightLb: 28.3 },
      { speciesKey: 'bluefin', weightLb: 410.0 },
    ],
  },
  {
    email: 'angler2@keysrun.test',
    password: 'keysrun-dev-pw-2',
    displayName: 'Reel Deal',
    catches: [
      { speciesKey: 'tarpon', weightLb: 98.1 },
      { speciesKey: 'mahi', weightLb: 41.7 },
      { speciesKey: 'bonefish', weightLb: 9.2 },
      { speciesKey: 'permit', weightLb: 31.4 },
    ],
  },
];

async function seedWorld(db: ReturnType<typeof createDb>['db']): Promise<void> {
  const existing = await db.select({ id: world.id }).from(world).where(eq(world.id, 1)).limit(1);
  if (existing.length > 0) {
    console.log('world row already present, skipping');
    return;
  }
  await db.insert(world).values({ id: 1, seed: WORLD_SEED, contentVersion: CONTENT_VERSION });
  console.log(`inserted world row (seed=${WORLD_SEED}, contentVersion=${CONTENT_VERSION})`);
}

async function seedUser(db: ReturnType<typeof createDb>['db'], spec: SeedUser): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, spec.email)).limit(1);
  if (existing.length > 0) {
    console.log(`user ${spec.email} already present, skipping`);
    return;
  }

  for (const c of spec.catches) {
    if (!SPECIES_KEYS.includes(c.speciesKey)) {
      throw new Error(`seed data error: unknown species key "${c.speciesKey}"`);
    }
  }

  const passwordHash = await hashPassword(spec.password);
  const [user] = await db
    .insert(users)
    .values({ email: spec.email, passwordHash, displayName: spec.displayName })
    .returning({ id: users.id });
  await db.insert(players).values({ userId: user.id });

  for (const c of spec.catches) {
    await recordCatch(db, { userId: user.id, speciesKey: c.speciesKey, weightLb: c.weightLb });
  }

  console.log(`inserted user ${spec.email} (${spec.displayName}) with ${spec.catches.length} catches`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    await seedWorld(db);
    for (const spec of SEED_USERS) {
      await seedUser(db, spec);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
