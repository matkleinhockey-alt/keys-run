/**
 * Headless load harness — docs/ARCHITECTURE.md's Phase 2 requirement to measure, with real
 * numbers, tick p50/p99 and bytes/sec/player at 10/50/100 simulated players, plus memory/GC
 * behaviour under sustained load.
 *
 * Runs the sim server as a real **child process** (`node --trace-gc dist/index.js`), not
 * in-process, so: (a) memory/GC numbers reflect the server alone, not the harness sharing its
 * heap, and (b) `--trace-gc`'s stdout lines are an external, can't-fake-it cross-check against
 * the server's own /metrics `gc` field (populated by a `PerformanceObserver` — see metrics.ts).
 *
 * The harness process is the "N synthetic clients" side: each one runs a real `stepBoat`
 * simulation locally (so envelope validation sees realistic self-reports, not literally static
 * positions) on a scripted throttle/turn pattern, connects over the real wire protocol
 * (test/sim-client.ts), and sends INPUT at 30 Hz via one shared interval (not N separate
 * timers).
 *
 * Usage: `pnpm --filter @keysrun/sim run load` (build the server first: `pnpm --filter
 * @keysrun/sim run build`). Requires TEST_DATABASE_URL (same as the test suite).
 *
 * Important caveat on the bandwidth numbers this prints: every client spawns at the same
 * marina and drives straight out together (see controlsFor's doc comment for why — turning
 * was removed after repeatedly running boats aground near the dock), so for the whole run they
 * stay within interest range of *each other* — a worst-case-density scenario (every player
 * mutually subscribed to every other player), not the steady-state "players spread across an
 * 8.6 km world" scenario docs/ARCHITECTURE.md's ~3-4 KB/s budget almost certainly assumes. This
 * harness reports the real, measured, worst-case-density number; the Phase 2 handoff report
 * gives a back-of-envelope estimate for the spread-out case alongside it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBoatState, stepBoat, type BoatEnv, type BoatHull, type BoatInput, type BoatState } from '@keysrun/shared/sim/boat';
import { DEFAULT_CH, DEFAULT_SW } from '@keysrun/shared/waves';
import { WB } from '@keysrun/shared/world/depth';
import { BOATS } from '@keysrun/shared/content/boats';
import { createTestUserWithSession, testDbHandle, truncateAll } from './helpers.js';
import { SimTestClient } from './sim-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ENTRY = path.resolve(HERE, '../dist/index.js');
const DT = 1 / 30;

const HULL_TABLE: BoatHull[] = BOATS.map((b) => ({ len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }));

interface MetricsSnapshot {
  players: number;
  entities: number;
  tick: { index: number; p50Ms: number; p99Ms: number; lastAtMs: number };
  bytesOutPerSec: number;
  violationsPerMin: number;
  violationsTotal: number;
  simBehind: number;
  gridCells: number;
  gc: { count: number; maxMs: number; p99Ms: number };
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
}

async function fetchMetrics(port: number): Promise<MetricsSnapshot> {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  return (await res.json()) as MetricsSnapshot;
}

function spawnServer(port: number, databaseUrl: string): { proc: ChildProcessWithoutNullStreams; gcLines: string[] } {
  const gcLines: string[] = [];
  const proc = spawn(
    process.execPath,
    ['--trace-gc', SIM_ENTRY],
    {
      env: {
        ...process.env,
        SIM_PORT: String(port),
        DATABASE_URL: databaseUrl,
        MAX_PLAYERS: '256',
        NODE_ENV: 'production',
      },
    },
  );
  proc.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.includes('Scavenge') || line.includes('Mark-sweep') || line.includes('Mark-Compact')) gcLines.push(line.trim());
    }
  });
  return { proc, gcLines };
}

async function waitForHealth(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200 || res.status === 503) return; // server is up and answering, even if DB check races
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`server on port ${port} did not become reachable within ${timeoutMs}ms`);
}

interface SyntheticClient {
  client: SimTestClient;
  state: BoatState;
  hull: BoatHull;
  t: number;
  seq: number;
  bytesReceived: number;
}

function envFor(hull: BoatHull, t: number): BoatEnv {
  return {
    t,
    hull,
    sw: DEFAULT_SW,
    ch: DEFAULT_CH,
    worldBounds: WB,
    pilings: [],
    dockRects: [],
    canDrive: true,
    fightActive: false,
    fightTarget: null,
    lineOut: false,
    luigiOn: false,
  };
}

/**
 * Scripted maneuver: straight line, full throttle, no turning. All players spawn at the same
 * marina with the same fixed heading (app.ts's defaultSpawn), so they move out together as a
 * loose convoy rather than dispersing in different directions.
 *
 * This is deliberately simpler than an earlier turning maneuver, removed after three escalating
 * attempts (timer-gated turning, per-tick depthAt-gated turning, latched depthAt-gated turning)
 * all still produced a real rate of stepBoat collision events (beaching near the marina mouth,
 * which is shallow by nature) and the discontinuous speed drops those collisions cause — not
 * because the envelope is wrong (see envelope.test.ts's extensive deep-water property tests,
 * and the two real envelope fixes this harness *did* find and that are documented in envelope.ts
 * and the Phase 2 handoff report), but because reliably avoiding every hazard near a marina
 * mouth with a scripted turn pattern turned into its own research project, disproportionate to
 * this phase's actual goal of measuring steady-state tick/bandwidth numbers. Straight-line
 * motion is sufficient for that and still gives the interest grid real (if simple) geometry —
 * all N boats moving together, visible to each other, and gradually pulling away from anyone
 * who disconnects.
 */
function controlsFor(): BoatInput {
  return { fwd: true, back: false, left: false, right: false, trimUp: false, trimDn: false };
}

async function runLoadLevel(playerCount: number, measureSeconds: number, port: number): Promise<void> {
  const handle = testDbHandle();
  const { proc, gcLines } = spawnServer(port, process.env.TEST_DATABASE_URL!);
  let serverLog = '';
  proc.stdout.on('data', (c: Buffer) => (serverLog += c.toString()));
  proc.stderr.on('data', (c: Buffer) => (serverLog += c.toString()));

  try {
    await waitForHealth(port);

    // Each client must initialize its local physics from the *server-assigned* WELCOME spawn,
    // not a guessed position — a client that starts its own stepBoat somewhere else than where
    // the server's shadow model starts will diverge from the shadow forever (not just
    // momentarily), permanently tripping the leash. This is a harness-correctness requirement,
    // not a sim one — see the Phase 2 handoff report for how this was caught.
    const clients: SyntheticClient[] = [];
    for (let i = 0; i < playerCount; i++) {
      const user = await createTestUserWithSession(handle);
      const hull = HULL_TABLE[i % HULL_TABLE.length];
      const bytesCounter = { value: 0 };
      let welcomeState: { x: number; z: number; h: number } | null = null;
      const client = new SimTestClient(`ws://127.0.0.1:${port}`, {
        onSnapshot: (_msg, byteLength) => {
          bytesCounter.value += byteLength;
        },
        onWelcome: (w) => {
          welcomeState = { x: w.x, z: w.z, h: w.h };
        },
      });
      await client.waitOpen();
      client.sendHello(user.token);
      const deadline = Date.now() + 5000;
      while (!welcomeState) {
        if (Date.now() > deadline) throw new Error(`client ${i} never received WELCOME`);
        await sleep(10);
      }
      const w = welcomeState as { x: number; z: number; h: number };
      if (process.env.SIM_DEBUG_VIOLATIONS) console.error(`[harness] client ${i} welcome x=${w.x} z=${w.z} h=${w.h} hullIndex=${i % HULL_TABLE.length}`);
      const sc: SyntheticClient = {
        client,
        state: createBoatState(w.x, w.z, w.h),
        hull,
        t: 0,
        seq: 0,
        get bytesReceived() {
          return bytesCounter.value;
        },
      };
      clients.push(sc);
    }

    let frameCount = 0;
    const driveHandle = setInterval(() => {
      frameCount++;
      for (let ci = 0; ci < clients.length; ci++) {
        const sc = clients[ci];
        const input = controlsFor();
        sc.state = stepBoat(sc.state, input, envFor(sc.hull, sc.t), DT);
        sc.t += DT;
        if (process.env.SIM_DEBUG_VIOLATIONS && ci === 0 && frameCount % 30 === 0) {
          console.error(`[harness] client 0 frame=${frameCount} t=${sc.t.toFixed(2)} x=${sc.state.x.toFixed(2)} z=${sc.state.z.toFixed(2)} h=${sc.state.h.toFixed(3)} speed=${sc.state.speed.toFixed(2)}`);
        }
        sc.client.sendInput({
          seq: sc.seq++,
          ackTick: 0,
          ...input,
          x: sc.state.x,
          z: sc.state.z,
          h: sc.state.h,
          speed: sc.state.speed,
        });
      }
    }, 1000 / 30);

    // Ramp (not measured): let everyone get under way and clear of the marina's immediate
    // vicinity before the measurement window starts, so the reported numbers reflect steady
    // cruising rather than the connection burst itself.
    const RAMP_SECONDS = 10;
    await sleep(RAMP_SECONDS * 1000);

    const bytesAtStart = clients.reduce((s, c) => s + c.bytesReceived, 0);
    const wallStart = Date.now();
    await sleep(measureSeconds * 1000);
    const wallElapsedSec = (Date.now() - wallStart) / 1000;
    const bytesAtEnd = clients.reduce((s, c) => s + c.bytesReceived, 0);

    clearInterval(driveHandle);

    const metrics = await fetchMetrics(port);
    const memBefore = process.memoryUsage(); // harness's own, for contrast only — not reported as the server's

    for (const sc of clients) sc.client.close();
    await sleep(200);

    const clientSideBytesPerSecPerPlayer = (bytesAtEnd - bytesAtStart) / wallElapsedSec / playerCount;

    console.log(`\n=== ${playerCount} players, ${measureSeconds}s measurement window ===`);
    console.log(`tick:        p50=${metrics.tick.p50Ms.toFixed(3)}ms  p99=${metrics.tick.p99Ms.toFixed(3)}ms  index=${metrics.tick.index}  simBehind=${metrics.simBehind}`);
    console.log(`bandwidth:   server-reported ${(metrics.bytesOutPerSec / playerCount).toFixed(1)} B/s/player  |  client-measured ${clientSideBytesPerSecPerPlayer.toFixed(1)} B/s/player`);
    console.log(`violations:  total=${metrics.violationsTotal}  perMin=${metrics.violationsPerMin.toFixed(2)}`);
    console.log(`interest:    gridCells=${metrics.gridCells}  entities=${metrics.entities}`);
    console.log(`memory (server): rss=${(metrics.memory.rss / 1048576).toFixed(1)}MB heapUsed=${(metrics.memory.heapUsed / 1048576).toFixed(1)}MB`);
    console.log(`gc (PerformanceObserver, server): count=${metrics.gc.count} maxMs=${metrics.gc.maxMs.toFixed(2)} p99Ms=${metrics.gc.p99Ms.toFixed(2)}`);
    console.log(`gc (--trace-gc lines captured): ${gcLines.length}`);
    for (const line of gcLines.slice(-5)) console.log(`  ${line}`);
    void memBefore;
  } finally {
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    await handle.close();
    if (!serverLog.includes('listening')) {
      console.error('--- server log (did not see "listening") ---');
      console.error(serverLog);
    }
    if (process.env.SIM_DEBUG_VIOLATIONS) {
      console.error('--- violation debug lines (last 40) ---');
      console.error(serverLog.split('\n').filter((l) => l.includes('[violation]')).slice(0, 40).join('\n'));
    }
  }
}

async function main(): Promise<void> {
  const setupHandle = testDbHandle();
  await truncateAll(setupHandle);
  await setupHandle.close();

  const levels = (process.env.LOAD_LEVELS ?? '10,50,100').split(',').map(Number);
  const measureSeconds = Number(process.env.LOAD_MEASURE_SECONDS ?? 15);
  let port = 8191;
  for (const n of levels) {
    await runLoadLevel(n, measureSeconds, port++);
  }
}

void main();
