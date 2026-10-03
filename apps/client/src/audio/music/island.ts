/**
 * The "Margaritaville" station: original, laid-back "gulf and western" island songs written on
 * the fly. Each song has a key and tempo, intro/verse/chorus/bridge/outro, a strummed acoustic
 * guitar (down-down-up-up-down-up), a bouncing bass, cross-stick drums with shaker and congas, a
 * harmonica-style lead singing a repeating melody, steel drum on the choruses, and a sliding pedal
 * steel solo on the bridge.
 *
 * Ported faithfully from legacy/index.html:3391-3457 (`SONG_TITLES`, `PENT`, `newSong`,
 * `chordOf`, `guitarStrum`, `harmonica`, `pedalSteel`, `islandStep`).
 */
import { rand } from '../../core/math.js';
import { bHit, mtof, pluck, steelPan, type MusicStation } from './theory.js';

const SONG_TITLES = [
  'Low Tide, High Hopes', 'Sunburn Serenade', 'Conch Shell Sunday', 'Flip-Flop Forecast', 'Two-Stroke Tuesday',
  'Mangrove Moon', 'Last Call at Mile Marker 50', 'Lime Wedge Lullaby', 'Hammock Weather', 'Tarpon Two-Step',
  'Barefoot at the Bait Shop', 'Seven Mile Sundown', 'No Shoes, No Schedule', 'Salt Life Shuffle', 'Hawk Channel Breeze',
];
const PENT = [0, 2, 4, 7, 9];

type LeadEvent = [number, number, number]; // [step, note, durSteps]
interface SongBar { sec: string; deg: number; lead: LeadEvent[] | null; last: boolean }
interface Song { key: number; bpm: number; bars: SongBar[]; title: string; start: number }

export function createIslandStation(ctx: AudioContext, out: AudioNode, noiseBuf: AudioBuffer): MusicStation {
  let song: Song | null = null;

  function mkLead(key: number, prog: readonly number[]): Array<LeadEvent[] | null> {
    const motifs = [[0, 4, 6, 8], [0, 3, 6, 10, 12], [2, 4, 6, 8, 12], [0, 2, 4, 8, 10], [4, 6, 8, 12, 14]];
    const motif = motifs[Math.floor(Math.random() * motifs.length)];
    const out: Array<LeadEvent[] | null> = [];
    let note = key + 12 + PENT[Math.floor(Math.random() * 3)];
    const pool: number[] = [];
    for (let o = 0; o < 2; o++) PENT.forEach((p) => pool.push(key + 12 + o * 12 + p));
    let phraseA: LeadEvent[] | null = null;
    const vi = 9, ii = 2;
    for (let b = 0; b < prog.length; b++) {
      const deg = prog[b];
      const ct = [0, deg === vi || deg === ii ? 3 : 4, 7].map((x) => key + 12 + deg + x);
      const ev: LeadEvent[] = [];
      if (b % 4 === 2 && phraseA) {
        phraseA.forEach((e) => ev.push([e[0], e[1] + (e === phraseA![phraseA!.length - 1] ? (Math.random() < 0.5 ? 2 : -3) : 0), e[2]]));
      } else {
        const steps = b % 2 === 1 ? motif.slice(0, Math.max(2, motif.length - 2)) : motif;
        steps.forEach((st, k) => {
          const last = k === steps.length - 1;
          let cand = pool.filter((n) => Math.abs(n - note) <= 5);
          if (last) cand = cand.filter((n) => ct.some((c) => (n - c) % 12 === 0)).concat(cand.length ? [] : [ct[0]]);
          if (!cand.length) cand = [ct[0]];
          note = cand[Math.floor(Math.random() * cand.length)];
          ev.push([st, note, last ? 16 - st : 2]);
        });
        if (b % 4 === 0) phraseA = ev;
      }
      out.push(ev);
    }
    return out;
  }

  function newSong(): void {
    const key = [62, 64, 57, 59, 55][Math.floor(Math.random() * 5)];
    const bpm = Math.round(rand(96, 112));
    const I = 0, IV = 5, V = 7, vi = 9;
    const intro = [I, IV, I, V], verse = [I, I, IV, I, I, V, IV, I], chorus = [IV, I, V, I, IV, I, V, I], bridge = [vi, IV, I, V], outro = [IV, V, I, I];
    const vLead = mkLead(key, verse), cLead = mkLead(key, chorus), bLead = mkLead(key, bridge);
    const secs: Array<{ n: string; p: number[]; lead: Array<LeadEvent[] | null> | null }> = [
      { n: 'intro', p: intro, lead: null }, { n: 'verse', p: verse, lead: vLead }, { n: 'chorus', p: chorus, lead: cLead },
      { n: 'verse', p: verse, lead: vLead }, { n: 'chorus', p: chorus, lead: cLead }, { n: 'bridge', p: bridge, lead: bLead },
      { n: 'chorus', p: chorus, lead: cLead }, { n: 'outro', p: outro, lead: null },
    ];
    const bars: SongBar[] = [];
    secs.forEach((sc) => sc.p.forEach((deg, b) => bars.push({ sec: sc.n, deg, lead: sc.lead ? sc.lead[b] : null, last: b === sc.p.length - 1 })));
    song = { key, bpm, bars, title: SONG_TITLES[Math.floor(Math.random() * SONG_TITLES.length)], start: 0 };
  }

  function chordOf(deg: number): [number, number, number] {
    const r = song!.key + deg, minor = deg === 2 || deg === 9;
    return [r, r + (minor ? 3 : 4), r + 7];
  }

  function guitarStrum(t: number, ch: readonly [number, number, number], down: boolean, dur: number, gain: number): void {
    const v = [ch[0] - 12, ch[2] - 12, ch[0], ch[1], ch[2], ch[0] + 12];
    const order = down ? v : v.slice().reverse();
    order.forEach((n, k) => pluck(ctx, out, t + k * 0.011, n, dur, gain * (down ? 1 : 0.7)));
  }

  function harmonica(t: number, m: number, dur: number, gain: number): void {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    const lfo = ctx.createOscillator(), ld = ctx.createGain();
    o.type = 'square'; o2.type = 'sawtooth'; o.frequency.value = o2.frequency.value = mtof(m); o2.detune.value = -9;
    lfo.frequency.value = 5.4; ld.gain.value = mtof(m) * 0.006; lfo.connect(ld); ld.connect(o.frequency); ld.connect(o2.frequency);
    bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 1.1;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.035);
    g.gain.setValueAtTime(gain * 0.85, t + Math.max(0.05, dur - 0.08)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    o.connect(bp); o2.connect(bp); bp.connect(g); g.connect(out);
    [o, o2, lfo].forEach((x) => { x.start(t); x.stop(t + dur + 0.15); });
  }

  function pedalSteel(t: number, m: number, dur: number, gain: number): void {
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    const lfo = ctx.createOscillator(), ld = ctx.createGain(), f = mtof(m);
    o.type = 'sawtooth'; o2.type = 'sine'; lp.type = 'lowpass'; lp.frequency.value = 1600;
    o.frequency.setValueAtTime(f * 0.89, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.22);
    o2.frequency.setValueAtTime(f * 0.89, t); o2.frequency.exponentialRampToValueAtTime(f, t + 0.22);
    lfo.frequency.value = 5; ld.gain.value = f * 0.004; lfo.connect(ld); ld.connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(out);
    [o, o2, lfo].forEach((x) => { x.start(t); x.stop(t + dur + 0.45); });
  }

  function islandStep(t: number, i: number): void {
    if (!song) newSong();
    let si = i - song!.start;
    if (si < 0 || si >= song!.bars.length * 16) { newSong(); song!.start = i; si = 0; }
    const st = si % 16, B = song!.bars[Math.floor(si / 16)], ch = chordOf(B.deg), spb = 60 / song!.bpm / 4, sec = B.sec;
    const nxt = song!.bars[Math.floor(si / 16) + 1] ?? B;

    // drums: kick on 1 and 3, cross-stick on 2 and 4, shaker eighths, conga fills at section ends
    if (st === 0 || st === 8) bHit(ctx, out, noiseBuf, t, { f0: 100, f1: 46, dur: 0.3, gain: sec === 'intro' ? 0.3 : 0.55 });
    if ((st === 4 || st === 12) && sec !== 'intro') {
      bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 2300, q: 3, dur: 0.05, gain: 0.3 });
      bHit(ctx, out, noiseBuf, t, { f0: 820, dur: 0.04, gain: 0.08, wave: 'triangle' });
    }
    if (st % 2 === 0) bHit(ctx, out, noiseBuf, t, { noise: true, freq: 6800, dur: 0.05, gain: st % 4 === 2 ? 0.07 : 0.04 });
    if (B.last && st >= 10) bHit(ctx, out, noiseBuf, t, { f0: [230, 190, 170][st % 3], f1: 150, dur: 0.16, gain: 0.18 });
    if (sec === 'chorus' && st === 0 && Math.random() < 0.5) bHit(ctx, out, noiseBuf, t, { f0: 2600, dur: 0.6, gain: 0.04, wave: 'sine' });

    // acoustic guitar: D D U U D U on the eighths
    const pat: Record<number, number> = { 0: 1, 4: 1, 6: 0, 10: 0, 12: 1, 14: 0 };
    if (st in pat) {
      const lastOutroStep = sec === 'outro' && Math.floor(si / 16) === song!.bars.length - 1 && st > 0;
      guitarStrum(t, ch, !!pat[st], st === 0 ? 0.9 : 0.4, lastOutroStep ? 0 : 0.035);
    }

    // bass: root and fifth with a walk-up into the next chord
    const root = ch[0] - 24, nroot = chordOf(nxt.deg)[0] - 24;
    if (st === 0) bHit(ctx, out, noiseBuf, t, { f0: mtof(root), dur: 0.42, gain: 0.36, wave: 'triangle', lp: 520, att: 0.006 });
    if (st === 8) bHit(ctx, out, noiseBuf, t, { f0: mtof(root + 7), dur: 0.32, gain: 0.32, wave: 'triangle', lp: 520, att: 0.006 });
    if (st === 12 || st === 14) {
      const w = st === 12 ? (nroot > root ? nroot - 2 : nroot + 2) : (nroot > root ? nroot - 1 : nroot + 1);
      bHit(ctx, out, noiseBuf, t, { f0: mtof(w), dur: 0.18, gain: 0.28, wave: 'triangle', lp: 520, att: 0.006 });
    }

    // the "singer": harmonica on the verses, harmonica plus steel drum on the choruses, pedal steel on the bridge
    if (B.lead) {
      for (const [s0, n, d] of B.lead) {
        if (s0 !== st) continue;
        const dur = d * spb;
        if (sec === 'bridge') pedalSteel(t, n, dur, 0.075);
        else {
          harmonica(t, n, dur, sec === 'chorus' ? 0.06 : 0.07);
          if (sec === 'chorus') steelPan(ctx, out, t, n + 12, Math.min(0.8, dur + 0.2), 0.07);
        }
      }
    }
    if (sec === 'intro' && st % 4 === 0 && Math.random() < 0.7) steelPan(ctx, out, t, ch[Math.floor(Math.random() * 3)] + 12, 0.6, 0.08);
    if (sec === 'chorus' && st === 0) ch.forEach((n) => bHit(ctx, out, noiseBuf, t, { f0: mtof(n), dur: (60 / song!.bpm) * 3.6, gain: 0.025, wave: 'sine', att: 0.2 }));
  }

  return {
    id: 'marg',
    name: 'Margaritaville',
    bpm: () => song?.bpm ?? 104,
    title: () => song?.title ?? null,
    step: islandStep,
    swing: 0.06,
  };
}
