/**
 * The tempo signal driving the dance (`dance.ts`) — kept as a small local interface rather than
 * importing the real audio system, because `apps/client/src/audio/**` does not exist on this
 * branch: it's pending, unmerged work on `feat/audio-life` (this task's brief explicitly says not
 * to touch it). That branch's `audio/music/radio.ts` already defines the exact shape this mirrors
 * — `MusicController.bpm()`: "Current beats-per-minute — the current station's when the radio is
 * on, else a steady 100 ... so the deck party and dance pole still sway gently to an implied beat
 * with the radio off" — and `entities/life/deck-party.ts` (same branch) reads it instead of
 * reimplementing it. `BeatSource` below is that same seam, so wiring the real controller in later
 * is: construct `{ bpm: () => audio.music.bpm(), isPlaying: () => audio.music.isOn() }` and pass
 * it as `createCrewSystem`'s third argument — one line at the `game/world.ts` call site, nothing
 * in `dance.ts` or `index.ts` changes.
 */
export interface BeatSource {
  /** Current tempo, beats per minute. */
  bpm(): number;
  /** True while music is actually audible — gates the Dancing state (vs. Idle). The real source
   * is `MusicController.isOn()`. */
  isPlaying(): boolean;
}

/** Free-running fallback: a steady implied tempo, always "on". Matches the same ~100-120 bpm
 * range `MusicController`'s own off-radio fallback (100) and the Hip-hop station (90) sit in, so
 * swapping in the real source later doesn't change the dance's character, just its sync. */
export function createFallbackBeatSource(bpm = 112): BeatSource {
  return {
    bpm: () => bpm,
    isPlaying: () => true,
  };
}
