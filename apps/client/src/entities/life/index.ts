/**
 * Life barrel: everything `game/world.ts` needs to wire the people, the deck party, world
 * traffic and the bird life into the running game, in one call — mirroring `audio/index.ts`'s
 * composition style.
 *
 * Owns: go-fast racers (racers.ts), ambient boat traffic (traffic.ts), pelican flocks
 * (pelicans.ts), hotspots/weedlines/rigs (hotspots.ts), the fishing buddy (buddy.ts), Luigi mode
 * (luigi.ts), Caelen (caelen.ts), the moored party boats off the beaches (party-boats.ts), and
 * the pirates' old wooden sloop that calls by every ~30 minutes (pirates.ts — nothing exists
 * while it is away), and driving the player's own boat's deck party/pole/shower (deck-party.ts) plus the idle animation
 * (blink/head-sway/hair-whip) for every human riding the
 * player's boat — `entities/boat/model.ts` builds `captain`/`crew`/`party` directly (not through
 * a `HumanRegistry`), so nothing else calls their `update()` every frame.
 *
 * ## Integration (for whoever wires this into `game/world.ts`)
 *
 * 1. Build once, after `electronics`/`tod`/`particles` exist: `createLifeSystems(scene, {x:spot.x,z:spot.z}, deps)`.
 * 2. Call `life.update(inputs)` once a frame, after `applyBoatVisuals` (needs the boat model's
 *    final transform) and after `updateCamera` (needs the final camera transform for tags/haze/
 *    rooster-tail placement) — same ordering legacy's `updateParty`/`updateLuigi`/`updateCaelen`/
 *    `updateBuddy`/`updateTraffic`/`updateRacers`/`updatePelicans`/`updateHotspots` ran at.
 * 3. Feed `audio.update()`'s `traffic`/`racers`/`buddy`/`gullSites` from `life.engineSources()`/
 *    `life.gullSites()`.
 * 4. `stubs.ts`'s `installWorldLife(life.legacySnapshot())` once, right after construction, lets
 *    `entities/boat/electronics.ts`'s existing (inert) sonar-trace loops — which import those
 *    stub names and are not this task's to flesh out — see something non-empty. `stubs.ts`'s
 *    `BUDDY` is a stable object whose `.on` the caller should keep mirroring from
 *    `life.isBuddyOn()` each frame (one line), since that one field *does* change at runtime.
 * 5. `#btnBuddy`'s click handler calls `life.toggleBuddy()`.
 */
import * as THREE from 'three';
import { createRacerFleet, type RacerFleet } from './racers.js';
import { createTrafficFleet, type TrafficFleet } from './traffic.js';
import { createPelicanFlocks, type PelicanFlocks } from './pelicans.js';
import type { SpotQuery } from '../../game/fishing/spot.js';
import { createHotspotWorld, type HotspotWorld, type GullSite } from './hotspots.js';
import { createFishingBuddy, type FishingBuddy } from './buddy.js';
import { createLuigiMode, type LuigiMode } from './luigi.js';
import { createCaelen, type Caelen, type CaelenDiverInput, type CaelenShotResult } from './caelen.js';
import { createPartyBoats, type PartyBoats } from './party-boats.js';
import { createPirates, type Pirates, type PirateLootSource } from './pirates.js';
import { updateParty } from './deck-party.js';
import type { BoatModel, BoatBuildDeps } from '../boat/model.js';
import type { LightMatEntry } from '../../core/time-of-day.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { RemoteEngineSource, PartySite, PirateSite } from '../../audio/interfaces.js';

export interface LifeDeps extends BoatBuildDeps {
  lightMats: LightMatEntry[];
  particles: ParticleSystem;
  /** `core/time-of-day.ts`'s live `TimeOfDayController.getK()` — distinct from `BoatBuildDeps`'s
   * own `todK`, a one-time snapshot taken at boat-build time; this one is polled every frame for
   * the cabin-light/underwater-light crossfade (deck-party.ts's `updatePole`). */
  currentTodK(): number;
  /** `audio/music/radio.ts`'s `MusicController.bpm()`. */
  bpm(): number;
  /** `audio/index.ts`'s composite `AudioSystem.update`'s underlying pieces — Luigi mode's hype
   * callout and Caelen's spoken line. */
  hypeCallout(): void;
  sayCaelenLine(): void;
  /** The player's wallet and cooler, for the pirates' appraisal. Optional: without it they still
   * come, and judge you broke. */
  pirateLoot?(): PirateLootSource | null;
  /** Unix-seconds clock for the pirates' schedule; defaults to the wall clock. Injectable so
   * nothing ever has to wait thirty minutes. */
  pirateNowS?(): number;
}

export interface LifeFrameInputs {
  dt: number;
  t: number;
  /** The player's own boat model (deck party/pole/shower/captain/crew idle animation) and spec id
   * (the buddy avoids whatever hull the player is currently driving). */
  model: BoatModel;
  boatLen: number;
  playerBoatId: string;
  boat: { x: number; y: number; z: number; h: number; speed: number; air: boolean };
  camera: THREE.PerspectiveCamera;
  viewport: { w: number; h: number };
  rendererEl: HTMLCanvasElement;
  /** `TRIM.v`, 0..1 — Luigi mode's trigger. */
  trimV: number;
  lineOut: boolean;
  /** `F.state==='caught'`. */
  fishCaught: boolean;
  /** Where the player is when they're in the water, or null/absent when aboard — Caelen drops
   * onto a tight orbit around a diver (entities/life/caelen.ts explains why). */
  diver?: CaelenDiverInput | null;
}

export interface LifeSystems {
  update(inputs: LifeFrameInputs): void;
  engineSources(): { traffic: RemoteEngineSource[]; racers: RemoteEngineSource[]; buddy: RemoteEngineSource | undefined };
  gullSites(): GullSite[];
  /** Fishing's spot lookup (game/fishing/spot.ts): live frenzies, weedlines, rigs. */
  spots: SpotQuery;
  /** Moored party boats within earshot, for `audio/engine.ts`'s `updateParties` — pass straight
   * into `audio.update`'s `parties`. */
  partySites(): readonly PartySite[];
  /** The pirate sloop for `audio/engine.ts`'s `updatePirates`, or null while they are away. */
  pirateSite(): PirateSite | null;
  isLuigiOn(): boolean;
  toggleBuddy(): void;
  isBuddyOn(): boolean;
  /** Tests one resolved spear shot against Caelen and applies his reaction — see
   * entities/life/caelen.ts's `resolveSpearShot`. `game/world.ts` calls this with the same ray it
   * already captures for the fish near-miss spook. */
  caelenShot(p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }): CaelenShotResult;
  /** Seconds until Caelen comes back, 0 when he's here. */
  caelenAwayFor(): number;
  /** VERIFICATION-ONLY: Caelen's live capsule, or null while he's away. */
  caelenDebugHitbox(): ReturnType<Caelen['debugHitbox']>;
  /** One-time arrays for `stubs.ts`'s `installWorldLife` — see this module's header, point 4. */
  legacySnapshot(): { rigs: ReadonlyArray<unknown>; weeds: ReadonlyArray<unknown>; hotspots: ReadonlyArray<unknown>; traffic: ReadonlyArray<unknown>; racers: ReadonlyArray<unknown> };
  dispose(): void;
}

export function createLifeSystems(scene: THREE.Scene, boatSpawn: { x: number; z: number }, deps: LifeDeps): LifeSystems {
  const racerFleet: RacerFleet = createRacerFleet(scene);
  const trafficFleet: TrafficFleet = createTrafficFleet(scene);
  const pelicans: PelicanFlocks = createPelicanFlocks(scene, boatSpawn);
  const hotspotWorld: HotspotWorld = createHotspotWorld(scene, deps.lightMats);
  const buddy: FishingBuddy = createFishingBuddy(scene, deps);
  const luigi: LuigiMode = createLuigiMode({ hypeCallout: deps.hypeCallout, particles: deps.particles });
  const caelen: Caelen = createCaelen(scene, { sayCaelenLine: deps.sayCaelenLine });
  const partyBoats: PartyBoats = createPartyBoats(scene);
  const pirates: Pirates = createPirates(scene, { loot: deps.pirateLoot, nowS: deps.pirateNowS });
  // DEV/VERIFICATION HOOK ONLY — the schedule is 30 wall-clock minutes, which nothing here can
  // wait out (the sandbox renders ~3 fps and measures in simulated seconds). Registered here, not
  // in world.ts, so the contested file needs no extra lines. No normal code path reads it.
  if (typeof window !== 'undefined') {
    (window as unknown as { __pirateDebug?: unknown }).__pirateDebug = {
      summon: (distM?: number) => pirates.summon(distM),
      state: () => pirates.debug(),
    };
  }

  return {
    update(inputs) {
      const { dt, t, model, boat, camera, viewport, rendererEl, boatLen, playerBoatId, trimV, lineOut, fishCaught } = inputs;
      const cameraXZ = { x: camera.position.x, z: camera.position.z };
      racerFleet.update(dt, t, boat, cameraXZ, deps.particles);
      trafficFleet.update(dt, t, boat, cameraXZ, deps.particles);
      pelicans.update(dt, t, boat, cameraXZ, deps.particles);
      hotspotWorld.update(dt, t, boat, cameraXZ, deps.particles);
      buddy.update(dt, t, boat, playerBoatId, camera, viewport, deps.particles);
      caelen.update(dt, t, boat, camera, viewport, inputs.diver ?? null);
      partyBoats.update(dt, t, camera.position, deps.particles, deps.currentTodK);
      pirates.update(dt, t, boat, camera, viewport, deps.particles, deps.currentTodK());

      // the player's own deck party/pole/shower, plus idle animation for every human aboard
      // (captain/crew/party aren't in a HumanRegistry — see this module's header).
      updateParty(dt, t, model, boat, {
        particles: deps.particles, cameraPos: camera.position, bpm: deps.bpm, todK: deps.currentTodK, luigiOn: luigi.isOn,
      });
      model.captain.update(t, boat.speed);
      model.crew.update(t, boat.speed);
      for (const P of model.party) P.h.update(t, boat.speed);

      luigi.update(dt, t, model, boatLen, { trimV, speed: boat.speed, lineOut, fishCaught }, camera, rendererEl);
    },
    engineSources() {
      return { traffic: trafficFleet.engineSources(), racers: racerFleet.engineSources(), buddy: buddy.engineSource() };
    },
    gullSites(): GullSite[] { return hotspotWorld.gullSites(); },
    spots: {
      nearHotspot: (x, z) => hotspotWorld.nearHotspot(x, z),
      nearWeed: (x, z) => hotspotWorld.nearWeed(x, z),
      nearRig: (x, z) => hotspotWorld.nearRig(x, z),
    },
    partySites(): readonly PartySite[] { return partyBoats.sites(); },
    pirateSite(): PirateSite | null { return pirates.site(); },
    isLuigiOn(): boolean { return luigi.isOn(); },
    toggleBuddy(): void { buddy.toggle(); },
    isBuddyOn(): boolean { return buddy.isOn(); },
    caelenShot(p1, p2): CaelenShotResult { return caelen.resolveSpearShot(p1, p2); },
    caelenAwayFor(): number { return caelen.awayFor(); },
    caelenDebugHitbox() { return caelen.debugHitbox(); },
    legacySnapshot() {
      return {
        rigs: hotspotWorld.listRigs(), weeds: hotspotWorld.listWeeds(), hotspots: hotspotWorld.listHotspots(),
        traffic: trafficFleet.listTraffic(), racers: racerFleet.listRacers(),
      };
    },
    dispose(): void {
      luigi.dispose();
      caelen.dispose();
      partyBoats.dispose();
      pirates.dispose();
      buddy.dispose();
    },
  };
}
