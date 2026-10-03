import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSimApp } from '../src/app.js';
import { World } from '../src/world/world.js';
import { hullOf } from '../src/app.js';
import { autosaveDirtyPlayers } from '../src/lifecycle.js';
import { createTestUserWithSession, testDbHandle, truncateAll } from './helpers.js';
import { SimTestClient } from './sim-client.js';
import type { WelcomeMsg } from '@keysrun/shared/proto';

const handle = testDbHandle();

beforeEach(async () => {
  await truncateAll(handle);
});

afterAll(async () => {
  await handle.close();
});

function listen(app: ReturnType<typeof buildSimApp>): Promise<number> {
  return new Promise((resolve) => {
    app.httpServer.listen(0, '127.0.0.1', () => {
      const addr = app.httpServer.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
}

describe('autosave', () => {
  it('flushes only dirty players and clears the dirty flag', async () => {
    const world = new World(4, hullOf);
    const sink: Uint8Array[] = [];
    const user = await createTestUserWithSession(handle);
    const result = world.connectPlayer(user.userId, 2, { x: 123, z: 1456, h: 0.5, speed: 3 }, (b) => sink.push(b), Date.now());
    const slot = result!.slot;
    world.tick(Date.now()); // marks conn.dirty = true

    await autosaveDirtyPlayers(world, handle.pool);

    const row = await handle.pool.query<{ resume: { x: number; z: number; hullIndex: number } }>('SELECT resume FROM players WHERE user_id = $1', [
      user.userId,
    ]);
    expect(row.rows[0].resume.x).toBeCloseTo(123, 5);
    expect(row.rows[0].resume.hullIndex).toBe(2);

    // conn.dirty was cleared — a second autosave with no new ticks should be a no-op (0 rows touched).
    expect(world.conns.get(slot)!.dirty).toBe(false);
  });
});

describe('graceful shutdown (end to end over a real ws connection)', () => {
  it('connects real clients, flushes their resume state to Postgres, and closes with code 4001', async () => {
    // A dedicated pool for the app under test: gracefulShutdown() ends it (step 6), which must
    // not tear down the shared `handle.pool` other tests/assertions in this file still use.
    const appHandle = testDbHandle();
    const app = buildSimApp({ pool: appHandle.pool, maxPlayers: 8, autosaveIntervalMs: 3_600_000 });
    const port = await listen(app);

    const userA = await createTestUserWithSession(handle);
    const userB = await createTestUserWithSession(handle);

    let welcomeA: WelcomeMsg | null = null;
    let welcomeB: WelcomeMsg | null = null;
    const closeCodes: number[] = [];

    const clientA = new SimTestClient(`ws://127.0.0.1:${port}`, {
      onWelcome: (w) => (welcomeA = w),
      onClose: (code) => closeCodes.push(code),
    });
    const clientB = new SimTestClient(`ws://127.0.0.1:${port}`, {
      onWelcome: (w) => (welcomeB = w),
      onClose: (code) => closeCodes.push(code),
    });

    await Promise.all([clientA.waitOpen(), clientB.waitOpen()]);
    clientA.sendHello(userA.token);
    clientB.sendHello(userB.token);

    await new Promise<void>((resolve) => {
      const check = () => (welcomeA && welcomeB ? resolve() : setTimeout(check, 20));
      check();
    });

    // Each client reports itself holding exactly at its spawn position for a few ticks — a
    // legitimate, non-violating session (see envelope.test.ts for why this matters).
    for (const [client, w] of [
      [clientA, welcomeA!],
      [clientB, welcomeB!],
    ] as const) {
      for (let seq = 0; seq < 5; seq++) {
        client.sendInput({ seq, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: w.x, z: w.z, h: w.h, speed: w.speed });
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    await new Promise((r) => setTimeout(r, 100)); // let a few ticks process

    const result = await app.shutdown();
    expect(result.flushedPlayers).toBe(2);
    expect(result.flushDurationMs).toBeLessThan(500);

    await new Promise<void>((resolve) => {
      const check = () => (closeCodes.length >= 2 ? resolve() : setTimeout(check, 20));
      check();
    });
    expect(closeCodes).toEqual([4001, 4001]);

    const rows = await handle.pool.query<{ user_id: string; resume: { x: number; z: number } }>('SELECT user_id, resume FROM players WHERE user_id = ANY($1)', [
      [userA.userId, userB.userId],
    ]);
    expect(rows.rows.length).toBe(2);
    for (const row of rows.rows) {
      expect(Number.isFinite(row.resume.x)).toBe(true);
    }
  }, 15000);
});

describe('reconnect-and-resume', () => {
  it('a player with a saved resume row is welcomed back at that exact position, not a fresh spawn', async () => {
    const appHandle = testDbHandle();
    const app = buildSimApp({ pool: appHandle.pool, maxPlayers: 8, autosaveIntervalMs: 3_600_000 });
    const port = await listen(app);

    try {
      const user = await createTestUserWithSession(appHandle);
      const savedResume = { x: -1234.5, z: 2345.6, h: 1.2345, speed: 7.89, hullIndex: 3, savedAtMs: Date.now() };
      await handle.pool.query('INSERT INTO players (user_id, resume) VALUES ($1, $2::jsonb)', [user.userId, JSON.stringify(savedResume)]);

      let welcome: WelcomeMsg | null = null;
      const client = new SimTestClient(`ws://127.0.0.1:${port}`, { onWelcome: (w) => (welcome = w) });
      await client.waitOpen();
      client.sendHello(user.token);

      const deadline = Date.now() + 5000;
      while (!welcome) {
        if (Date.now() > deadline) throw new Error('never received WELCOME on reconnect');
        await new Promise((r) => setTimeout(r, 10));
      }

      const w = welcome as WelcomeMsg;
      // Quantized over the wire (see Q.X/Q.Z/Q.H/Q.SPEED in proto/messages.ts) — compare within
      // that documented error, not exact equality.
      expect(w.x).toBeCloseTo(savedResume.x, 0);
      expect(w.z).toBeCloseTo(savedResume.z, 0);
      expect(w.h).toBeCloseTo(savedResume.h, 2);
      expect(w.speed).toBeCloseTo(savedResume.speed, 1);
      expect(w.hullIndex).toBe(savedResume.hullIndex);

      client.close();
    } finally {
      app.stopLoops();
      await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
      await appHandle.close();
    }
  }, 10000);

  it('a brand-new player (no resume row) gets the default spawn, not an error', async () => {
    const appHandle = testDbHandle();
    const app = buildSimApp({ pool: appHandle.pool, maxPlayers: 8, autosaveIntervalMs: 3_600_000 });
    const port = await listen(app);

    try {
      const user = await createTestUserWithSession(appHandle);
      let welcome: WelcomeMsg | null = null;
      const client = new SimTestClient(`ws://127.0.0.1:${port}`, { onWelcome: (w) => (welcome = w) });
      await client.waitOpen();
      client.sendHello(user.token);

      const deadline = Date.now() + 5000;
      while (!welcome) {
        if (Date.now() > deadline) throw new Error('never received WELCOME for a new player');
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(Number.isFinite((welcome as WelcomeMsg).x)).toBe(true);
      client.close();
    } finally {
      app.stopLoops();
      await new Promise<void>((resolve) => app.httpServer.close(() => resolve()));
      await appHandle.close();
    }
  }, 10000);
});
