/**
 * Boat stereo: three procedurally-generated radio stations, or your own song loaded from disk,
 * played through the boat's speakers with an HRTF-panned source and an analyser driving the
 * cockpit LEDs on the beat. The station DJ (Margaritaville) cuts in now and then.
 *
 * Ported faithfully from legacy/index.html:3353-3362 (`MUSIC`, `musicInit`), 3378-3383
 * (`musicStopFile`/`musicOff`/`musicPlayFile`/`musicLoadFile`), 3517-3530 (`STATIONS`,
 * `beatScheduler`, `musicPlayStation`, `musicPlayBeat`, `musicToggle`, `updateMusicBtn`), and
 * 3540-3547 (`updateMusic`). `djLine` (3532-3539) lives in `dj.ts`.
 *
 * The cockpit-LED-pulse and speaker-position panning are the one place legacy's music system
 * reaches directly into the boat model (`boat.model.speakerPos`/`.leds`) — ported here behind the
 * small local `SpeakerSink` interface rather than an import from `entities/boat/**`, which this
 * task does not own. INTEGRATION POINT: whoever wires this module into `game/world.ts` adapts
 * `BoatModel`'s `speakerPos`/`leds` to `SpeakerSink` and passes it to `update()`.
 */
import { lerp, rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import type { AudioEngine } from '../engine.js';
import { createBeatStation } from './beat.js';
import { createIslandStation } from './island.js';
import { createHouseStation } from './house.js';
import { createDj, type DuckTarget } from './dj.js';
import { makeMusicNoiseBuffer } from './theory.js';
import type { MusicStation } from './theory.js';

export interface SpeakerSink {
  position(): { x: number; y: number; z: number };
  /** Legacy `m.leds` — each entry's `base` colour, scaled by `0.25 + 1.6*level`, gets written
   * back via `setColor`. Optional: boats with no LED strip just omit this. */
  leds?: ReadonlyArray<{ base: { r: number; g: number; b: number }; setColor(r: number, g: number, b: number): void }>;
}

export interface MusicController {
  isOn(): boolean;
  /** Station name + (for island/house) the current song title, e.g. `'📻 Beno Bonanza · "Reef Rave"'`, or `'📻 Off'` — legacy `updateMusicBtn`. */
  label(): string;
  /** 0..1 analyser-derived level, for anything that wants to pulse with the beat even without a `SpeakerSink` (e.g. a UI VU meter). */
  level(): number;
  /** Current beats-per-minute — the current station's when the radio is on, else a steady 100
   * (legacy `MUSIC.on?STATIONS[MUSIC.st].bpm():100`, index.html:3291) so the deck party and dance
   * pole still sway gently to an implied beat with the radio off. `entities/life/deck-party.ts`'s
   * whole "dancing is beat-synced to the radio" coupling reads this instead of reimplementing it. */
  bpm(): number;
  /** legacy `MUSIC.on&&!MUSIC.userOff` (index.html:4164): true once at boot, and again after an
   * explicit `toggle()`-to-on, false forever after an explicit `toggle()`-to-off. Lets the
   * "leave the dock" flow auto-start the house station a couple of seconds in without stomping
   * on a station the user already chose (including "off"). */
  shouldAutoStart(): boolean;
  playStation(index: 0 | 1 | 2): void;
  /** legacy `musicToggle` (index.html:3524-3529): Beno Bonanza -> Margaritaville -> Hip-hop -> off. */
  toggle(): void;
  off(): void;
  loadFile(file: File): void;
  /** Runs the beat scheduler's own setInterval tick immediately (used by tests that don't want to
   * wait on real wall-clock time); normally the scheduler free-runs on its own timer. */
  update(dt: number, t: number, speaker?: SpeakerSink): void;
  /** legacy's Luigi-mode hook (index.html:3617-3629): ducks whatever's playing for the air
   * horn/crowd-roar/hype-man callout. See `entities/life/luigi.ts`. */
  hypeCallout(): void;
  /** legacy `caelenSays`'s speech half (index.html:3720-3723); the squawk is `engine.caelenSquawk()`. */
  sayCaelenLine(): void;
  dispose(): void;
}

export function createMusicController(engine: AudioEngine): MusicController {
  let out: GainNode | null = null;
  let pan: PannerNode | null = null;
  let analyser: AnalyserNode | null = null;
  let analyserData: Uint8Array<ArrayBuffer> | null = null;
  let el: HTMLAudioElement | null = null;
  let elSrc: MediaElementAudioSourceNode | null = null;

  let on = false;
  let mode: 'beat' | 'file' = 'beat';
  let stationIdx: 0 | 1 | 2 = 1;
  let next = 0;
  let step = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let level = 0;
  let djT: number | null = null;
  let userOff = false;

  let stations: MusicStation[] | null = null;
  let dj: ReturnType<typeof createDj> | null = null;

  function ensureInit(): boolean {
    const { ctx, bus } = engine._internal;
    if (!ctx || !bus) return false; // engine.init() hasn't run yet (needs a user gesture)
    if (out) return true;
    out = ctx.createGain(); out.gain.value = 0;
    pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 10; pan.rolloffFactor = 1;
    analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    out.connect(analyser); out.connect(pan); pan.connect(bus);
    const noiseBuf = makeMusicNoiseBuffer(ctx);
    stations = [createIslandStation(ctx, out, noiseBuf), createBeatStation(ctx, out, noiseBuf), createHouseStation(ctx, out, noiseBuf)];
    dj = createDj(ctx, bus, noiseBuf, engine.isMuted);
    return true;
  }

  function duckTarget(): DuckTarget | undefined {
    return out ? { gain: out, restoreTo: 0.85 } : undefined;
  }

  function stopFile(): void { el?.pause(); }

  function off(): void {
    on = false;
    clearInterval(timer);
    stopFile();
    const ctx = engine._internal.ctx;
    if (out && ctx) out.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
  }

  function beatScheduler(): void {
    const ctx = engine._internal.ctx;
    if (!ctx || !stations) return;
    const S = stations[stationIdx];
    const spb = 60 / S.bpm() / 4;
    while (next < ctx.currentTime + 0.12) {
      const swing = step % 2 ? spb * S.swing : 0;
      S.step(next + swing, step);
      next += spb;
      step++;
    }
  }

  function playStation(index: 0 | 1 | 2): void {
    engine.init();
    if (!ensureInit() || !out) return;
    stopFile();
    stationIdx = index; mode = 'beat'; on = true;
    next = engine._internal.ctx!.currentTime + 0.05;
    step = 0;
    clearInterval(timer);
    timer = setInterval(beatScheduler, 25);
    out.gain.setTargetAtTime(0.85, engine._internal.ctx!.currentTime, 0.2);
  }

  /** legacy `musicToggle` (index.html:3524-3529). */
  function toggle(): void {
    if (!on) { userOff = false; playStation(2); toast('📻 Beno Bonanza — house music, four on the floor. P changes the station.'); }
    else if (stationIdx === 2) { playStation(0); toast('📻 Margaritaville — easygoing island songs.'); }
    else if (stationIdx === 0) { playStation(1); toast('📻 Hip-hop station — boom-bap beats on the boat speakers.'); }
    else { off(); userOff = true; toast('📻 Radio off.'); }
  }

  function loadFile(file: File): void {
    engine.init();
    if (!ensureInit() || !out) return;
    const ctx = engine._internal.ctx!;
    if (!el) {
      el = new Audio(); el.loop = true;
      elSrc = ctx.createMediaElementSource(el);
      elSrc.connect(out);
    }
    el.src = URL.createObjectURL(file);
    clearInterval(timer);
    mode = 'file'; on = true;
    el.play().catch(() => toast('That file could not be played.'));
    out.gain.setTargetAtTime(0.9, ctx.currentTime, 0.2);
    toast('Now playing "' + file.name.replace(/\.[^.]+$/, '').slice(0, 40) + '" on the boat speakers.');
  }

  function label(): string {
    if (!on || !stations) return '📻 Off';
    const S = stations[stationIdx];
    const title = S.title();
    return '📻 ' + S.name + (title ? ' · "' + title + '"' : '');
  }

  function update(dt: number, _t: number, speaker?: SpeakerSink): void {
    if (!out || !pan || !analyser || !analyserData) return;
    // The Margaritaville DJ cuts in now and then, same cadence as legacy's `MUSIC.djT`.
    if (on && mode === 'beat' && stationIdx === 0) {
      djT = (djT ?? rand(40, 70)) - dt;
      if (djT <= 0) { djT = rand(150, 240); dj?.djLine(duckTarget()); }
    }
    if (speaker) {
      const p = speaker.position();
      const now = engine._internal.ctx!.currentTime;
      pan.positionX.setTargetAtTime(p.x, now, 0.04); pan.positionY.setTargetAtTime(p.y, now, 0.04); pan.positionZ.setTargetAtTime(p.z, now, 0.04);
    }
    let lv = 0;
    if (on) {
      analyser.getByteFrequencyData(analyserData);
      for (let i = 0; i < 8; i++) lv += analyserData[i];
      lv /= 8 * 255;
    }
    level = lerp(level, lv, Math.min(1, dt * 24)); // legacy's `lerp(level,lv,.4)` was per-call at ~60fps; scale to real dt
    speaker?.leds?.forEach((led) => led.setColor(led.base.r * (0.25 + 1.6 * level), led.base.g * (0.25 + 1.6 * level), led.base.b * (0.25 + 1.6 * level)));
  }

  function isOn(): boolean { return on; }
  function levelFn(): number { return level; }
  function bpmFn(): number { return on && stations ? stations[stationIdx].bpm() : 100; }
  function shouldAutoStart(): boolean { return !on && !userOff; }

  /** legacy's Luigi-mode hook (index.html:3617): `hypeCallout` ducks whatever's playing. Exposed
   * so `entities/life/luigi.ts` can call it without reaching into this module's internals. */
  function hypeCallout(): void { ensureInit(); dj?.hypeCallout(duckTarget()); }

  function sayCaelenLine(): void { ensureInit(); dj?.sayCaelenLine(); }

  function dispose(): void {
    clearInterval(timer);
    stopFile();
  }

  return { isOn, label, level: levelFn, bpm: bpmFn, shouldAutoStart, playStation, toggle, off, loadFile, update, hypeCallout, sayCaelenLine, dispose };
}
