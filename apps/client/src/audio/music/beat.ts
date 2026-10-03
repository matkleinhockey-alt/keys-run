/**
 * The "Hip-hop" station: a 90 BPM boom-bap beat — dusty kick and snare, swung hats, a
 * minor-seventh soul progression on a warm electric piano, walking bass, vinyl crackle. One
 * continuous instrumental loop (no discrete songs, unlike the island/house stations).
 *
 * Ported faithfully from legacy/index.html:3363 (`BEAT`) and 3369-3377 (`beatStep`).
 */
import { bHit, mtof, type MusicStation } from './theory.js';

const BEAT = {
  bpm: 90,
  prog: [[57, 60, 64, 67], [50, 53, 57, 60], [55, 59, 62, 66], [48, 52, 55, 59]],
  bass: [[[45, 0], [45, 6], [52, 10]], [[38, 0], [38, 7], [45, 12]], [[43, 0], [43, 6], [50, 10]], [[36, 0], [40, 8], [43, 12]]],
} as const;

export function createBeatStation(ctx: AudioContext, out: AudioNode, noiseBuf: AudioBuffer): MusicStation {
  function beatStep(t: number, i: number): void {
    const st = i % 16, bar = Math.floor(i / 16) % 4;
    if (st === 0 || st === 7 || st === 10) bHit(ctx, out, noiseBuf, t, { f0: 120, f1: 42, dur: 0.42, gain: 0.9 });
    if (st === 4 || st === 12) {
      bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 1800, q: 0.8, dur: 0.22, gain: 0.55 });
      bHit(ctx, out, noiseBuf, t, { f0: 190, f1: 140, dur: 0.12, gain: 0.35, wave: 'triangle' });
    }
    if (st % 2 === 0 || Math.random() < 0.18) bHit(ctx, out, noiseBuf, t, { noise: true, freq: 7000, dur: st % 4 === 2 ? 0.09 : 0.04, gain: st % 4 === 2 ? 0.16 : 0.09 });
    if (st === 0 || st === 8) {
      for (const n of BEAT.prog[bar]) {
        for (const d of [-6, 6]) bHit(ctx, out, noiseBuf, t, { f0: mtof(n), dur: st === 0 ? 1.25 : 0.6, gain: 0.07, wave: 'triangle', det: d, att: 0.01, lp: 1800 });
      }
    }
    for (const [n, s0] of BEAT.bass[bar]) if (s0 === st) bHit(ctx, out, noiseBuf, t, { f0: mtof(n), dur: 0.38, gain: 0.38, wave: 'sine', att: 0.008 });
    if (Math.random() < 0.35) bHit(ctx, out, noiseBuf, t + Math.random() * 0.1, { noise: true, freq: 3000, dur: 0.012, gain: 0.05 });
  }

  return { id: 'beat', name: 'Hip-hop', bpm: () => BEAT.bpm, title: () => null, step: beatStep, swing: 0.18 };
}
