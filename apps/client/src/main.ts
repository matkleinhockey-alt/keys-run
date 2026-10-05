/**
 * Boot: build the world (declaration-only modules, explicit init order — see
 * docs/ARCHITECTURE.md requirement 4 and game/world.ts), then run the render loop.
 *
 * Ported from legacy/index.html:4178-4208 (resize, context-loss recovery, `frame()`), with one
 * deliberate change required by docs/ARCHITECTURE.md requirement 2: legacy ran physics at
 * render rate (`dt=Math.min(.05,clock.getDelta())` fed straight into `updateBoat`); the fixed
 * 30 Hz accumulator this requires now lives in `World.frame()` (game/world.ts), which this file
 * just calls once per animation frame with the real elapsed time.
 *
 * feat/net-client additions (this is the one module that wires the net, ui/auth and
 * ui/leaderboard pieces to the game, since it's the only file that owns both `initWorld`'s
 * result and the render loop — see those modules' own doc comments for what each piece does):
 *   1. `mountAuthGate()` runs before `initWorld` — the task brief's "gate entry to the game on
 *      being logged in, with a clearly-marked 'play offline' path"; offline resolves immediately
 *      with no network code ever touched, so the game stays playable with zero server
 *      dependency either way.
 *   2. When online, a `NetClient` connects to apps/sim and a `RemoteBoatManager` renders every
 *      other player into `world.scene`; both are fed from the render loop below at native frame
 *      rate (the 30 Hz input send and reconnect timers live *inside* NetClient on their own
 *      `setInterval`s — see its doc comment for why that must not be rAF-driven).
 *   3. The leaderboard panel mounts regardless of online/offline — it talks to apps/api
 *      directly and has nothing to do with the live `sim` connection.
 */
import { initWorld } from './game/world.js';
import { toast } from './ui/toast.js';
import { mountAuthGate } from './ui/auth/gate.js';
import { mountLeaderboard } from './ui/leaderboard/panel.js';
import { NetClient } from './net/client.js';
import { createRemoteBoatManager } from './net/remote-boats.js';
import { createBanner } from './net/banner.js';
import { SIM_WS_URL } from './net/config.js';

const wrap = document.getElementById('wrap');
if (!wrap) throw new Error('main: #wrap not found');

async function boot(): Promise<void> {
  const gate = await mountAuthGate();

  const world = initWorld(wrap!);

  new ResizeObserver(() => world.resize()).observe(wrap!);
  world.resize();

  world.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    try { toast('Graphics hiccup — refreshing the screen…'); } catch { /* noop */ }
    setTimeout(() => {
      if (world.renderer.getContext().isContextLost()) location.reload();
    }, 1500);
  });
  world.renderer.domElement.addEventListener('webglcontextrestored', () => {
    world.resize();
  });

  mountLeaderboard(wrap!, gate.mode === 'online' ? { token: gate.token, userId: gate.userId, displayName: gate.displayName } : null);

  let net: NetClient | null = null;
  let remoteBoats: ReturnType<typeof createRemoteBoatManager> | null = null;

  if (gate.mode === 'online') {
    const banner = createBanner(wrap!);
    remoteBoats = createRemoteBoatManager(world.scene, world.camera, wrap!);
    net = new NetClient({
      wsUrl: SIM_WS_URL,
      tokenHex: gate.token,
      events: {
        onConnectionState: (state, detail) => banner.setState(state, detail),
        onWelcome: (w) => world.setHullIndexForNet(w.hullIndex),
        onServerRestart: (etaMs) => banner.showServerRestart(etaMs),
      },
    });
    net.connect();
    toast(`Signed in as ${gate.displayName} — connecting to the shared world…`);
    // Debug/verification hook (task brief: "Measure: bytes/sec observed client-side") — query
    // `window.__krNet.getBytesPerSec()` / `.getPresenceCount()` / `.getLatencyMs()` from devtools.
    (window as unknown as { __krNet?: NetClient }).__krNet = net;
  } else {
    toast('Playing offline — log in any time from a refresh to join the shared world.');
  }

  let last = performance.now();
  let frameErrT = -99;
  // Local clock for remote boats' cosmetic wave-bob only (net/remote-boats.ts) — it has no
  // access to game/world.ts's internal `simTime`, and a constant clock offset only shifts the
  // wave sum's phase by a fixed amount, not a growing one, so this is a deliberate, harmless
  // approximation rather than a sync bug.
  let netSimT = 0;

  function frame(): void {
    requestAnimationFrame(frame); // keep the loop alive no matter what
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    try {
      if (net) {
        net.setLocalState(world.getLocalBoat());
        const correction = net.consumeCorrection(Math.min(0.1, dt));
        if (correction) world.applyNetCorrection(correction);
      }
      world.frame(dt);
      if (net && remoteBoats) {
        netSimT += Math.min(0.05, dt);
        // One `getRemoteBoats` call feeds both consumers: the 3D boats and the minimap's contact
        // markers must agree, and extrapolation is time-dependent, so calling it twice per frame
        // would hand them poses from two different instants.
        const snapshots = net.getRemoteBoats(now);
        remoteBoats.update(now, netSimT, snapshots);
        world.setRemoteBoatsForNet(snapshots.map((s) => ({ x: s.pose.x, z: s.pose.z, h: s.pose.h })));
      }
    } catch (e) {
      const t = now / 1000;
      if (t - frameErrT > 5) { frameErrT = t; console.error('frame update error', e); }
    }
  }
  frame();
}

void boot();
