/**
 * Audio barrel: everything `game/world.ts` (or an integration test harness) needs to wire real
 * audio into the game, in one call. Owns the AudioContext lifecycle (user-gesture `init()`,
 * visibility-change suspend/resume, the mute button) and composes the three independent pieces
 * this task built:
 *
 *  - `engine.ts`   — V8 engine synth, water/wind ambience, reel, remote-boat engines, gull calls.
 *  - `underwater.ts` — surface-crossing muffle + breathing/bubbles/reef-crackle/heartbeat.
 *  - `music/radio.ts` — the three radio stations, DJ lines, Luigi-mode hype callout.
 *
 * ## Integration points (for whoever wires this into `game/world.ts`)
 *
 * None of `world/**`, `entities/fish/**`, `entities/diver/**`, `entities/boat/**` or `game/**`
 * are imported here — this package is self-contained per the task brief. The seams are:
 *
 * 1. **User gesture**: call `audio.init()` from the start-screen "Go" button (or any click/key
 *    handler) — `AudioContext` cannot start without one. Safe to call repeatedly.
 * 2. **Per-frame**: call `audio.update(frame)` once a frame with an `AudioFrameInputs` built from
 *    the boat's `BoatState`/`Boat` spec, the camera, and this task's own
 *    `entities/life/{buddy,traffic,racers}.ts` outputs (optional — omit any you haven't wired).
 * 3. **Underwater**: construct a `SurfaceTransitionSource` from whatever the underwater-render
 *    agent exposes for the y=0 crossing and pass it to `createAudioSystem`. Until that lands,
 *    pass `{ isUnderwater: () => false }` and underwater audio simply never engages.
 * 4. **Breath-hold heartbeat**: likewise, a `BreathSource` from the diver agent's breath-hold
 *    state. Omit it and the heartbeat never engages (never-holding default — see `underwater.ts`).
 * 5. **Radio speaker position / LEDs**: pass a `SpeakerSink` (small local interface, see
 *    `music/radio.ts`) adapting `BoatModel.speakerPos`/`.leds` — or omit it; the radio still
 *    plays, just unpositioned and without LED pulsing.
 * 6. **Life-system one-shots**: `entities/life/luigi.ts` calls `audio.music.hypeCallout()` and
 *    `audio.engine.slam/splash/...`; `entities/life/caelen.ts` calls `audio.engine.caelenSquawk()`
 *    and `audio.music` (via `dj.ts`'s `sayCaelenLine`, re-exported below as
 *    `audio.sayCaelenLine()`) for its speech bubble line.
 */
import { createAudioEngine, type AudioFrameInputs } from './engine.js';
import { createUnderwaterAudio } from './underwater.js';
import { createMusicController, type SpeakerSink } from './music/radio.js';
import { toast } from '../ui/toast.js';
import type { SurfaceTransitionSource, BreathSource } from './interfaces.js';

export type { AudioFrameInputs, PlayerEngineInputs, ListenerPose, ReelAudioState, ReelAudioMode } from './engine.js';
export type { SurfaceTransitionSource, BreathSource, RemoteEngineSource, GullSite } from './interfaces.js';
export type { SpeakerSink } from './music/radio.js';

export interface AudioSystem {
  engine: ReturnType<typeof createAudioEngine>;
  music: ReturnType<typeof createMusicController>;
  /** Start the AudioContext — call from a user gesture (click/keydown). Idempotent. */
  init(): void;
  /** Mute/unmute everything (engine + music share one master gain); toasts and updates the
   * `#btnSound` label itself, matching legacy `AUD.toggle`'s side effects. */
  toggleMute(): void;
  isMuted(): boolean;
  /** One call per frame: engine ambience/engines/remote boats, underwater muffle/ambience, and
   * the radio's DJ-line timer + LED/pan update. `speaker` is optional (see integration point 5). */
  update(frame: AudioFrameInputs, speaker?: SpeakerSink): void;
  /** Caelen's spoken line (the squawk sound itself is `engine.caelenSquawk()`). */
  sayCaelenLine(): void;
  dispose(): void;
}

const ALWAYS_SURFACED: SurfaceTransitionSource = { isUnderwater: () => false };

export function createAudioSystem(surface: SurfaceTransitionSource = ALWAYS_SURFACED, breath?: BreathSource): AudioSystem {
  const engine = createAudioEngine();
  const music = createMusicController(engine);
  const underwater = createUnderwaterAudio(engine, surface, breath);
  let unbindVisibility: (() => void) | null = null;

  function init(): void {
    const wasReady = engine.isReady();
    engine.init();
    if (!wasReady && engine.isReady() && !unbindVisibility) unbindVisibility = engine.bindVisibilitySuspend();
  }

  function toggleMute(): void {
    const on = engine.toggleMute();
    const btn = document.getElementById('btnSound');
    if (btn) btn.textContent = on ? '🔊' : '🔇';
    toast(on ? 'Sound on.' : 'Sound off.');
  }

  function update(frame: AudioFrameInputs, speaker?: SpeakerSink): void {
    engine.update(frame);
    underwater.update(frame.dt);
    music.update(frame.dt, frame.t, speaker);
  }

  function sayCaelenLine(): void {
    engine.caelenSquawk();
    music.sayCaelenLine();
  }

  function dispose(): void {
    unbindVisibility?.();
    underwater.dispose();
    music.dispose();
    engine.dispose();
  }

  return { engine, music, init, toggleMute, isMuted: engine.isMuted, update, sayCaelenLine, dispose };
}
