/**
 * Voice lines via `speechSynthesis`: the best available browser voice, the Margaritaville
 * station's DJ cutting in now and then, and the Luigi-mode hype callout (air horn + crowd roar +
 * a hype-man shouting over the music, which ducks while he talks).
 *
 * Ported faithfully from legacy/index.html:3612-3629 (`_voices`, `bestVoice`, `airHorn`,
 * `crowdRoar`, `hypeCallout`) and 3532-3539 (`djLine`). `caelenSquawk`'s own synth voice stays in
 * `entities/life/caelen.ts`'s caller via `AudioEngine.gull`-style one-shots exposed from
 * `engine.ts` (see `createAudioEngine`'s public API) — nothing bird-specific belongs in the music
 * module.
 */
import { toast } from '../../ui/toast.js';

let voices: SpeechSynthesisVoice[] = [];
try {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    voices = window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => { voices = window.speechSynthesis.getVoices(); };
  }
} catch { /* speechSynthesis unavailable (e.g. some headless test environments) */ }

/** legacy `bestVoice` (index.html:3614-3616) — the most natural-sounding voice on offer, neural/
 * enhanced ones first, preferring a male US voice. */
export function bestVoice(): SpeechSynthesisVoice | null {
  const have = voices.length ? voices : (typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis.getVoices() : []);
  const vs = have.filter((v) => /^en/i.test(v.lang));
  if (!vs.length) return null;
  const score = (v: SpeechSynthesisVoice): number =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 10 : 0) +
    (/google us english|aria|guy|davis|jason|tony|christopher|eric|roger|andrew|brian|evan|aaron/i.test(v.name) ? 4 : 0) +
    (/en-US/i.test(v.lang) ? 3 : 0) +
    (/male|david|daniel|fred|alex|tom/i.test(v.name) ? 2 : 0) -
    (/female|zira|samantha|victoria|karen|moira|tessa|fiona/i.test(v.name) ? 3 : 0) -
    (/compact|espeak/i.test(v.name) ? 6 : 0);
  return vs.slice().sort((a, b) => score(b) - score(a))[0];
}

export function speak(text: string, rate: number, pitch: number, volume = 1): void {
  try {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = bestVoice();
    if (v) u.voice = v;
    u.rate = rate; u.pitch = pitch; u.volume = volume;
    window.speechSynthesis.speak(u);
  } catch { /* speechSynthesis unavailable */ }
}

/** A gain node the DJ should duck (and restore) while talking — i.e. the music bus. Optional:
 * callers with no music playing simply omit it. */
export interface DuckTarget { gain: GainNode; restoreTo: number }

function duck(ctx: AudioContext, target: DuckTarget | undefined, to: number, timeConstant: number): void {
  target?.gain.gain.setTargetAtTime(to, ctx.currentTime, timeConstant);
}
function unduck(ctx: AudioContext, target: DuckTarget | undefined, timeConstant: number, delayMs = 0): void {
  if (!target) return;
  setTimeout(() => target.gain.gain.setTargetAtTime(target.restoreTo, ctx.currentTime, timeConstant), delayMs);
}

/** legacy `airHorn` (index.html:3618). */
function airHorn(ctx: AudioContext, bus: AudioNode, t0: number): void {
  ([[0, 0.42], [0.5, 0.16], [0.72, 0.62]] as const).forEach(([dt, dur]) => {
    const t = t0 + dt;
    const g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2600;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.02);
    g.gain.setValueAtTime(0.09, t + dur - 0.04); g.gain.linearRampToValueAtTime(0, t + dur);
    f.connect(g); g.connect(bus);
    [466, 587, 698, 932].forEach((fr, k) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(fr * 0.97, t); o.frequency.linearRampToValueAtTime(fr, t + 0.05);
      o.detune.value = (k - 1.5) * 7;
      o.connect(f); o.start(t); o.stop(t + dur + 0.02);
    });
  });
}

/** legacy `crowdRoar` (index.html:3620-3622). */
function crowdRoar(ctx: AudioContext, bus: AudioNode, noiseBuf: AudioBuffer, t0: number): void {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 0.6;
  const g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
  lfo.frequency.value = 7; lg.gain.value = 0.015; lfo.connect(lg); lg.connect(g.gain);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.06, t0 + 0.4);
  g.gain.linearRampToValueAtTime(0.045, t0 + 1.6); g.gain.linearRampToValueAtTime(0, t0 + 3.2);
  s.connect(bp); bp.connect(g); g.connect(bus);
  s.start(t0); lfo.start(t0); s.stop(t0 + 3.3); lfo.stop(t0 + 3.3);
}

export interface Dj {
  /** legacy `hypeCallout` (index.html:3623-3629) — Luigi mode's horn/roar/hype-man shout. Pass
   * the music bus as `musicDuck` if a station is playing so it ducks under the callout. */
  hypeCallout(musicDuck?: DuckTarget): void;
  /** legacy `djLine` (index.html:3532-3539) — the Margaritaville announcer. */
  djLine(musicDuck?: DuckTarget): void;
  /** legacy `caelenSays`'s speech half (index.html:3720-3723) — the squawk synth itself is
   * `AudioEngine.caelenSquawk()`; this is just the line. */
  sayCaelenLine(): void;
}

export function createDj(ctx: AudioContext, bus: AudioNode, noiseBuf: AudioBuffer, isMuted: () => boolean): Dj {
  function hypeCallout(musicDuck?: DuckTarget): void {
    if (isMuted()) return;
    const now = ctx.currentTime;
    airHorn(ctx, bus, now);
    crowdRoar(ctx, bus, noiseBuf, now + 0.1);
    duck(ctx, musicDuck, 0.35, 0.1);
    unduck(ctx, musicDuck, 0.5, 3600);
    setTimeout(() => {
      speak('Luigi mode!', 1.05, 1.05);
      speak('Neeeeeck!', 0.7, 0.85);
      speak('Fuck!', 1.15, 0.7);
    }, 700);
  }

  function djLine(musicDuck?: DuckTarget): void {
    const line = 'Margaritaville — easy music to get hammered to.';
    if (!isMuted()) {
      duck(ctx, musicDuck, 0.3, 0.2);
      const u = new SpeechSynthesisUtterance('Margaritaville. Easy music to get hammered to.');
      u.rate = 0.92; u.pitch = 0.85; u.volume = 0.9;
      const v = bestVoice();
      if (v) u.voice = v;
      u.onend = () => unduck(ctx, musicDuck, 0.4);
      try {
        if (window.speechSynthesis) {
          window.speechSynthesis.speak(u);
          setTimeout(() => unduck(ctx, musicDuck, 0.4), 6000); // in case onend never fires
        }
      } catch { /* speechSynthesis unavailable */ }
    }
    toast('🎙️ ' + line);
  }

  function sayCaelenLine(): void {
    speak("You didn't make this... you didn't make this.", 1.08, 1.9);
  }

  return { hypeCallout, djLine, sayCaelenLine };
}
