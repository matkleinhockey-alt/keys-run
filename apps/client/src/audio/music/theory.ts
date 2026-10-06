/**
 * Shared music-synthesis primitives used by all three radio stations (`beat.ts`, `island.ts`,
 * `house.ts`): MIDI-to-frequency, the generic drum/bass/pad "hit" (legacy `bHit`,
 * index.html:3365-3368), and the three melodic instrument voices legacy reused across the island
 * and house stations (`pluck`, `steelPan`, and island's own `guitarStrum`/`harmonica`/`pedalSteel`,
 * which live in `island.ts` since nothing else uses them).
 *
 * Every function here takes `(ctx, out, ...)` explicitly rather than closing over them, mirroring
 * legacy's flat global-function style (just typed) — there is exactly one live radio station at a
 * time, so there is no benefit to a per-station factory closure.
 */

export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export interface HitOpts {
  dur: number;
  gain: number;
  att?: number;
  /** Noise-based hit (kick/snare/hat/perc) through a biquad filter, vs. an oscillator tone. */
  noise?: boolean;
  type?: BiquadFilterType;
  freq?: number;
  q?: number;
  wave?: OscillatorType;
  f0?: number;
  f1?: number;
  det?: number;
  lp?: number;
}

/** legacy `bHit` (index.html:3365-3368) — the one workhorse used for every drum/bass/pad hit
 * across all three stations. `noiseBuf` is a shared brown-noise buffer (see `radio.ts`). */
export function bHit(ctx: AudioContext, out: AudioNode, noiseBuf: AudioBuffer, t: number, o: HitOpts): void {
  const g = ctx.createGain();
  g.connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(o.gain, t + (o.att ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  if (o.noise) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = o.type ?? 'highpass'; f.frequency.value = o.freq ?? 1000; f.Q.value = o.q ?? 0.7;
    s.connect(f); f.connect(g);
    s.start(t, Math.random() * 1.5); s.stop(t + o.dur + 0.02);
  } else {
    const s = ctx.createOscillator(); s.type = o.wave ?? 'sine';
    s.frequency.setValueAtTime(o.f0 ?? 440, t);
    if (o.f1) s.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur * 0.6);
    if (o.det) s.detune.value = o.det;
    let node: AudioNode = s;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; s.connect(f); node = f; }
    node.connect(g);
    s.start(t); s.stop(t + o.dur + 0.02);
  }
}

/** legacy `pluck` (index.html:3416-3420) — a plucked-string voice (guitar strums, house arps). */
export function pluck(ctx: AudioContext, out: AudioNode, t: number, m: number, dur: number, gain: number): void {
  const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  o.type = 'sawtooth'; o2.type = 'triangle';
  o.frequency.value = o2.frequency.value = mtof(m); o2.detune.value = 6;
  f.type = 'lowpass'; f.Q.value = 1.5;
  f.frequency.setValueAtTime(3800, t); f.frequency.exponentialRampToValueAtTime(420, t + 0.35);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f); o2.connect(f); f.connect(g); g.connect(out);
  o.start(t); o2.start(t); o.stop(t + dur + 0.02); o2.stop(t + dur + 0.02);
}

/** legacy `steelPan` (index.html:3385-3386) — four partials, a bright metallic pluck. */
export function steelPan(ctx: AudioContext, out: AudioNode, t: number, m: number, dur: number, gain: number): void {
  const f0 = mtof(m);
  const g = ctx.createGain(); g.connect(out);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  ([[1, 1], [2, 0.42], [3.98, 0.16], [5.1, 0.06]] as const).forEach(([k, a]) => {
    const o = ctx.createOscillator(), ga = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f0 * k; ga.gain.value = a;
    o.connect(ga); ga.connect(g);
    o.start(t); o.stop(t + dur + 0.02);
  });
}

/** Deterministic-enough brown-noise buffer for the vinyl crackle / hats / kicks that every
 * station's `bHit(noise:true)` reads from. Cosmetic audio texture, so `Math.random()` is fine
 * (not gameplay-relevant placement — see docs/ARCHITECTURE.md's "Seeding" section). */
export function makeMusicNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
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

export interface MusicStation {
  id: string;
  name: string;
  bpm(): number;
  /** Title of whatever's currently playing, if the station tracks one (island/house do; beat
   * doesn't — it's one continuous instrumental, not discrete songs). */
  title(): string | null;
  step(t: number, i: number): void;
  /** 0..1 — how far into the current swing each odd 16th-note step should be nudged late. */
  swing: number;
}
