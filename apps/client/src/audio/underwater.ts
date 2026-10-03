/**
 * Underwater audio: the muffle crossfade on the surface crossing, plus the sound of actually
 * being down there — your own breathing and bubbles (the dominant sound underwater, and what
 * makes freediving tense), distant reef crackle, muted engine noise from boats above, and a
 * breath-hold heartbeat that quickens as air runs low.
 *
 * NEW — there is no underwater in legacy/index.html (docs/ARCHITECTURE.md: "this is literally why
 * there is no underwater today" re: the water plane). This module only has two real integration
 * points, both deliberately tiny local interfaces (see `interfaces.ts`) rather than imports from
 * `world/**` or `entities/diver/**`, which this task does not own and which don't exist yet:
 *
 *  - `SurfaceTransitionSource` — the underwater/render agent's y=0 crossing signal. Polled once a
 *    frame (`isUnderwater()`); if that agent also exposes a push event, pass it as `onCross` and
 *    this module subscribes for a same-frame crossfade start instead of up to 1 frame of poll lag.
 *  - `BreathSource` — the diver agent's breath-hold model, for the heartbeat cue.
 *
 * "Muted engine noise from boats above" needs no separate synth: every topside engine/ambience
 * sound already routes through `engine.ts`'s `underwaterFilter` (bus -> filter -> compressor), so
 * crossfading that one filter's cutoff on the way down already muffles the player's own idling
 * engine and any nearby traffic/buddy/racer engines exactly as "heard from underwater." This
 * module only has to add the sounds that belong to *being* underwater, routed through the
 * parallel `underwaterBus` so they are never muffled by the same filter.
 */
import { clamp, lerp, rand } from '../core/math.js';
import type { AudioEngine } from './engine.js';
import type { SurfaceTransitionSource, BreathSource } from './interfaces.js';

export interface UnderwaterAudio {
  update(dt: number): void;
  dispose(): void;
}

/** Always-full-air, never-holding — the sane default when no diver system is wired in yet, so
 * this module works standalone (heartbeat simply never engages). */
const NO_BREATH: BreathSource = { airFraction: () => 1, isHolding: () => false };

export function createUnderwaterAudio(engine: AudioEngine, surface: SurfaceTransitionSource, breath: BreathSource = NO_BREATH): UnderwaterAudio {
  const internal = engine._internal;
  if (!internal.ctx || !internal.underwaterFilter || !internal.underwaterBus) {
    // Engine hasn't called init() yet (no user gesture so far) — degrade to a no-op rather than
    // throwing, since `update()` may be called every frame before the first click.
    return { update() { /* waiting on a user gesture to start the AudioContext */ }, dispose() { /* nothing built */ } };
  }
  // Re-bind as plain (non-getter) consts of their non-null type, rather than relying on narrowing
  // of `internal.ctx` etc: TS does not carry a property-access null-check across the nested
  // closures below (bubblePop/crackle/heartbeatThump/update), but it does trust a `const`'s own
  // declared type everywhere, including inside closures.
  const ctx: AudioContext = internal.ctx;
  const underwaterFilter: BiquadFilterNode = internal.underwaterFilter;
  const underwaterBus: GainNode = internal.underwaterBus;

  let under = surface.isUnderwater();
  let unsubscribe: (() => void) | undefined;
  if (surface.onCross) unsubscribe = surface.onCross((goingUnder) => { under = goingUnder; });

  // ---- breathing + bubbles: the dominant underwater sound -----------------------------------
  // Built as its own small noise buffer rather than reaching into the engine's internal one,
  // which is private to engine.ts.
  const breathBuf = makeNoiseBuffer(ctx);
  const breathSrc = ctx.createBufferSource(); breathSrc.buffer = breathBuf; breathSrc.loop = true; breathSrc.start();
  const breathBP = ctx.createBiquadFilter(); breathBP.type = 'bandpass'; breathBP.frequency.value = 480; breathBP.Q.value = 0.9;
  const breathGain = ctx.createGain(); breathGain.gain.value = 0;
  const breathLfo = ctx.createOscillator(); breathLfo.type = 'sine'; breathLfo.frequency.value = 1 / 4.2; // one inhale/exhale cycle ~4.2s
  const breathDepth = ctx.createGain(); breathDepth.gain.value = 0;
  breathLfo.connect(breathDepth); breathDepth.connect(breathGain.gain); breathLfo.start();
  breathSrc.connect(breathBP); breathBP.connect(breathGain); breathGain.connect(underwaterBus);

  // bubble "pops": short, randomly-timed high noise clicks, more frequent while actually holding
  // breath (kicking/exhaling) than while idle at the surface-adjacent shallows.
  const bubbleBuf = makeNoiseBuffer(ctx);
  function bubblePop(): void {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = bubbleBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = rand(900, 2600); f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(rand(0.04, 0.09) * uwLevel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(f); f.connect(g); g.connect(underwaterBus);
    src.start(t, Math.random() * 1.2); src.stop(t + 0.12);
  }
  let bubbleT = rand(0.3, 1.2);

  // ---- distant reef crackle: the "shrimp snap" chorus --------------------------------------
  const crackleBuf = makeNoiseBuffer(ctx);
  function crackle(): void {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = crackleBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = rand(3200, 6500); f.Q.value = rand(4, 9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(rand(0.01, 0.03) * uwLevel, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(underwaterBus);
    src.start(t, Math.random() * 1.2); src.stop(t + 0.06);
  }

  // ---- breath-hold heartbeat: lub-dub, rate and loudness both rise as air runs low ----------
  function heartbeatThump(strength: number): void {
    const t = ctx.currentTime;
    for (const [delay, freq, dur, gain] of [[0, 56, 0.16, 0.22], [0.14, 46, 0.2, 0.16]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const g = ctx.createGain();
      o.frequency.setValueAtTime(freq, t + delay);
      o.frequency.exponentialRampToValueAtTime(freq * 0.7, t + delay + dur);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(gain * strength, t + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g); g.connect(underwaterBus);
      o.start(t + delay); o.stop(t + delay + dur + 0.02);
    }
  }
  let heartbeatT = 0;

  let uwLevel = 0; // the underwaterBus crossfade target, 0..1 — also scales one-shot gains above

  function update(dt: number): void {
    // Only poll when there's no push event to subscribe to instead — see the constructor, which
    // already subscribed via `onCross` if the underwater agent offered one.
    if (!surface.onCross) under = surface.isUnderwater();
    const now = ctx.currentTime;
    const targetHz = under ? 420 : 20000;
    underwaterFilter.frequency.setTargetAtTime(targetHz, now, 0.09); // ~200ms-ish crossfade, legacy's "most important moment"
    uwLevel = lerp(uwLevel, under ? 1 : 0, Math.min(1, dt * 4));
    underwaterBus.gain.setTargetAtTime(uwLevel * 0.9, now, 0.1);

    if (uwLevel < 0.01) return; // nothing left to drive while fully surfaced

    // breathing cycle: louder while actually holding breath than while just standing in shallows
    const holding = breath.isHolding();
    breathGain.gain.setTargetAtTime(holding ? 0.1 * uwLevel : 0.04 * uwLevel, now, 0.3);
    breathDepth.gain.setTargetAtTime(holding ? 0.07 * uwLevel : 0.02 * uwLevel, now, 0.3);
    breathBP.frequency.setTargetAtTime(holding ? 520 : 440, now, 0.3);

    bubbleT -= dt;
    if (bubbleT <= 0) { bubbleT = holding ? rand(0.4, 1.4) : rand(1.5, 4); bubblePop(); }

    if (Math.random() < dt * 2.2) crackle();

    const air = clamp(breath.airFraction(), 0, 1);
    if (holding && air < 0.97) {
      // bpm ramps from a resting ~62 at full air up to a panicked ~150 near blackout.
      const bpm = lerp(150, 62, air);
      heartbeatT -= dt * (bpm / 60);
      if (heartbeatT <= 0) { heartbeatT = 1; heartbeatThump(uwLevel * lerp(1.6, 0.7, air)); }
    } else {
      heartbeatT = Math.min(heartbeatT, 1);
    }
  }

  function dispose(): void {
    unsubscribe?.();
    try { breathSrc.stop(); breathLfo.stop(); } catch { /* already stopped */ }
    try { breathSrc.disconnect(); breathBP.disconnect(); breathGain.disconnect(); breathLfo.disconnect(); breathDepth.disconnect(); } catch { /* already disconnected */ }
  }

  return { update, dispose };
}

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 1.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b = 0.97 * b + 0.03 * w;
    d[i] = w * 0.6 + b * 2.5;
  }
  return buf;
}
