/**
 * The "Beno Bonanza" station: an endless set of original house tracks, each written on the fly in
 * its own style (deep, tech, piano, disco, tropical, or progressive) with its own key, tempo,
 * chords, bass line and arrangement — intro -> build -> drop -> breakdown -> build -> drop ->
 * outro, then straight into the next track.
 *
 * Ported faithfully from legacy/index.html:3461-3516 (`HOUSE_TITLES`, `HOUSE_STYLES`,
 * `H_PROGS`, `newHouse`, `houseStep`).
 */
import { rand } from '../../core/math.js';
import { bHit, mtof, pluck, steelPan, type MusicStation } from './theory.js';

const HOUSE_TITLES = [
  'Mile Marker Midnight', 'Sandbar Sunrise', 'Tarpon Tide', 'Boot Key Groove', 'Seven Mile Jack', 'Neon Mangroves',
  'Biscayne Afterglow', 'Reef Rave', 'Salt & Strobe', 'Hawk Channel Heat', 'Trim It Up', 'Wake Zone',
  'Flats at Four AM', 'Sombrero Lights', 'Gulf Stream Pulse', 'No Wake, No Sleep', 'Bait Ball Bounce',
  'Outrigger Disco', 'Blue Water Bounce', 'Pelican Drop',
];

type Lead = 'perc' | 'marimba' | 'arp' | null;
interface HouseStyle { bpm: [number, number]; minor: boolean; chords: string; bass: string; hats: string; lead: Lead }
const HOUSE_STYLES: Record<string, HouseStyle> = {
  deep: { bpm: [120, 122], minor: true, chords: 'pad+stab', bass: 'offbeat', hats: 'soft', lead: null },
  tech: { bpm: [125, 127], minor: true, chords: 'none', bass: 'rolling', hats: 'ride', lead: 'perc' },
  piano: { bpm: [122, 124], minor: false, chords: 'piano', bass: 'octave', hats: 'open', lead: null },
  disco: { bpm: [120, 123], minor: false, chords: 'filtered', bass: 'disco', hats: 'tamb', lead: null },
  tropical: { bpm: [108, 112], minor: false, chords: 'soft', bass: 'offbeat', hats: 'shaker', lead: 'marimba' },
  prog: { bpm: [124, 126], minor: true, chords: 'pad', bass: 'offbeat', hats: 'ride', lead: 'arp' },
};
const H_PROGS = {
  minor: [[0, -4, -7, -5], [0, -2, -4, -2], [0, 3, -2, -4], [0, -4, 1, -2], [0, -5, -2, -7]],
  major: [[0, 5, -3, 7], [0, -3, 5, 7], [0, 7, -3, 5], [0, 4, 5, 7], [0, -5, -3, -1]],
};

type Chord = [number, number, number, number];
interface HouseBar { n: string; b: number; len: number }
interface HouseSong {
  style: string; S: HouseStyle; root: number; bpm: number;
  chords: Chord[]; stabRx: number[]; motif: Array<[number, number]>; bars: HouseBar[];
  title: string; start: number;
}

export function createHouseStation(ctx: AudioContext, out: AudioNode, noiseBuf: AudioBuffer): MusicStation {
  let house: HouseSong | null = null;

  function newHouse(): void {
    const keys = Object.keys(HOUSE_STYLES);
    let style = keys[Math.floor(Math.random() * keys.length)];
    if (house && style === house.style) style = keys[(keys.indexOf(style) + 1) % keys.length];
    const S = HOUSE_STYLES[style];
    const root = 45 + Math.floor(Math.random() * 8);
    const bpm = Math.round(rand(S.bpm[0], S.bpm[1]));
    const progs = H_PROGS[S.minor ? 'minor' : 'major'];
    const P = progs[Math.floor(Math.random() * progs.length)];
    const chords: Chord[] = P.map((o, k): Chord => {
      const r = root + o;
      // `o===-3||o===2||o===4` already rules out 0, so the legacy `&&o!==0` guard is always true —
      // kept out here (TS flags it as a provably-redundant comparison) since dropping it changes
      // nothing about which chords come out minor.
      const minorCh = S.minor ? (k !== 2 || Math.random() < 0.6) : (o === -3 || o === 2 || o === 4);
      return [r, r + (minorCh ? 3 : 4), r + 7, r + (minorCh ? 10 : 11)];
    });
    const stabOptions = [[0, 3, 6, 10], [2, 6, 10, 14], [0, 6, 8, 14], [3, 6, 11, 14], [0, 3, 8, 11, 14]];
    const stabRx = stabOptions[Math.floor(Math.random() * stabOptions.length)];
    const motif: Array<[number, number]> = [];
    for (let k = 0; k < 8; k++) motif.push([k * 2 + (Math.random() < 0.3 ? 1 : 0), Math.floor(Math.random() * 4)]);
    const sections: Array<[string, number]> = [['intro', 16], ['build', 8], ['drop', 32], ['break', 8], ['roll', 4], ['drop', 32], ['outro', 8]];
    const bars: HouseBar[] = [];
    sections.forEach(([n, len]) => { for (let b = 0; b < len; b++) bars.push({ n, b, len }); });
    house = { style, S, root, bpm, chords, stabRx, motif, bars, title: HOUSE_TITLES[Math.floor(Math.random() * HOUSE_TITLES.length)], start: 0 };
  }

  function houseStep(t: number, i: number): void {
    if (!house) newHouse();
    let si = i - house!.start;
    if (si < 0 || si >= house!.bars.length * 16) { newHouse(); house!.start = i; si = 0; }
    const H = house!, S = H.S, st = si % 16, B = H.bars[Math.floor(si / 16)], ch = H.chords[Math.floor(si / 16) % 4], n = B.n, spb = 60 / H.bpm / 4;
    const kick = n !== 'break' && n !== 'roll', full = n === 'drop';
    const bassOn = n === 'build' || n === 'drop' || (n === 'outro' && B.b < 4);
    const chordsOn = n === 'drop' || n === 'break' || (n === 'build' && B.b >= 4);
    const leadOn = n === 'drop' && B.b >= 8;

    // drums
    if (kick && st % 4 === 0) bHit(ctx, out, noiseBuf, t, { f0: S.minor ? 120 : 132, f1: 44, dur: 0.3, gain: H.style === 'tropical' ? 0.7 : 0.95 });
    if ((st === 4 || st === 12) && (full || n === 'build' || n === 'outro')) {
      if (H.style === 'tropical') bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 2600, q: 2, dur: 0.06, gain: 0.32 });
      else {
        bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 1400, q: 1.2, dur: 0.14, gain: 0.4 });
        bHit(ctx, out, noiseBuf, t + 0.012, { noise: true, type: 'bandpass', freq: 1750, q: 1.2, dur: 0.18, gain: 0.25 });
      }
    }
    if ((st % 4 === 2 && n !== 'intro') || (st % 4 === 2 && B.b >= 8)) bHit(ctx, out, noiseBuf, t, { noise: true, freq: 8500, dur: S.hats === 'open' ? 0.16 : 0.1, gain: n === 'break' ? 0.05 : 0.12 });
    if (S.hats === 'ride' && full && st % 2 === 0) {
      bHit(ctx, out, noiseBuf, t, { f0: 5200, dur: 0.25, gain: 0.012, wave: 'square' });
      bHit(ctx, out, noiseBuf, t, { noise: true, freq: 9000, dur: 0.2, gain: 0.04 });
    }
    if (S.hats === 'tamb' && (full || n === 'build')) bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 7000, q: 2, dur: 0.05, gain: st % 2 ? 0.06 : 0.035 });
    if (S.hats === 'shaker' || S.hats === 'soft') bHit(ctx, out, noiseBuf, t, { noise: true, freq: 9500, dur: 0.03, gain: st % 2 ? 0.035 : 0.055 });
    if (full && [3, 7, 10, 13].includes(st) && (H.style === 'deep' || H.style === 'tropical' || H.style === 'tech')) bHit(ctx, out, noiseBuf, t, { f0: st % 2 ? 260 : 195, f1: st % 2 ? 210 : 160, dur: 0.16, gain: 0.11 });

    // bass
    if (bassOn) {
      const r = ch[0] - 12;
      let note: number | null = null, dur = 0.2;
      if (S.bass === 'offbeat' && (st % 4 === 2 || st === 15)) note = r + (st === 15 ? 7 : 0);
      else if (S.bass === 'rolling' && st % 2 === 1) { note = r + (st === 7 || st === 15 ? (st === 7 ? 3 : -2) : 0); dur = 0.11; }
      else if (S.bass === 'octave' && (st % 4 === 2 || st === 7 || st === 11)) note = r + (st === 7 ? 12 : 0);
      else if (S.bass === 'disco' && st % 2 === 0) { note = r + (st % 4 === 2 ? 12 : 0) + (st === 14 ? 7 : 0); dur = 0.14; }
      if (note !== null) {
        bHit(ctx, out, noiseBuf, t, { f0: mtof(note), dur, gain: 0.32, wave: 'sawtooth', lp: H.style === 'tech' ? 320 : 480, att: 0.004 });
        bHit(ctx, out, noiseBuf, t, { f0: mtof(note), dur, gain: 0.2, wave: 'sine', att: 0.004 });
      }
    }

    // chords
    if (chordsOn) {
      const C = S.chords;
      if ((C === 'pad' || C === 'pad+stab' || n === 'break') && st === 0) {
        ch.forEach((m) => bHit(ctx, out, noiseBuf, t, { f0: mtof(m + 12), dur: spb * 16 * 0.98, gain: n === 'break' ? 0.045 : 0.022, wave: 'sawtooth', lp: n === 'break' ? 1500 : 900, att: 0.3 }));
      }
      if ((C === 'pad+stab' || C === 'piano') && H.stabRx.includes(st) && n !== 'break') {
        ch.forEach((m) => {
          for (const d of [-6, 6]) bHit(ctx, out, noiseBuf, t, { f0: mtof(m + (C === 'piano' ? 24 : 12)), dur: C === 'piano' ? 0.35 : 0.2, gain: C === 'piano' ? 0.055 : 0.045, wave: 'triangle', det: d, lp: C === 'piano' ? 4200 : 2600, att: 0.003 });
          if (C === 'piano') bHit(ctx, out, noiseBuf, t, { f0: mtof(m + 36), dur: 0.15, gain: 0.012 });
        });
      }
      if (C === 'filtered' && st % 4 === 2 && n !== 'break') {
        ch.forEach((m) => bHit(ctx, out, noiseBuf, t, { f0: mtof(m + 12), dur: 0.16, gain: 0.05, wave: 'sawtooth', lp: 900 + 700 * Math.sin((si / 64) * Math.PI * 2), att: 0.004 }));
      }
      if (C === 'soft' && (st === 0 || st === 10) && n !== 'break') {
        ch.forEach((m) => bHit(ctx, out, noiseBuf, t, { f0: mtof(m + 12), dur: 0.5, gain: 0.03, wave: 'triangle', lp: 2000, att: 0.02 }));
      }
    }

    // lead
    if (leadOn || (n === 'break' && S.lead === 'marimba')) {
      if (S.lead === 'arp') {
        const seq = [0, 1, 2, 3, 2, 1, 3, 2];
        pluck(ctx, out, t, ch[seq[st % 8]] + 24 + (st >= 8 ? 12 : 0), 0.22, 0.03);
      }
      if (S.lead === 'marimba') for (const [s0, k] of H.motif) if (s0 === st) steelPan(ctx, out, t, ch[k] + 24, 0.45, 0.09);
      if (S.lead === 'perc' && (st === 3 || st === 11 || st === 14)) bHit(ctx, out, noiseBuf, t, { f0: mtof(ch[0] + 36), dur: 0.07, gain: 0.05, wave: 'square', lp: 3000 });
    }

    // build-up roll and riser
    if (n === 'roll' || (n === 'build' && B.b >= B.len - 2)) {
      const dens = B.b >= B.len - 1 ? 1 : 2;
      if (st % dens === 0) bHit(ctx, out, noiseBuf, t, { noise: true, type: 'bandpass', freq: 1800 + st * 90 + B.b * 300, q: 1, dur: 0.07, gain: 0.1 + 0.012 * st + B.b * 0.03 });
    }
    if (n === 'roll' && B.b === 0 && st === 0) bHit(ctx, out, noiseBuf, t, { noise: true, type: 'highpass', freq: 900, dur: spb * 64, gain: 0.08, att: spb * 60 });
  }

  return {
    id: 'house',
    name: 'Beno Bonanza',
    bpm: () => house?.bpm ?? 124,
    title: () => house?.title ?? null,
    step: houseStep,
    swing: 0,
  };
}
