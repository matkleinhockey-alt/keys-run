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
import { createCommercialFleet, type CommercialFleet } from './commercial.js';
import { createPelicanFlocks, type PelicanFlocks } from './pelicans.js';
import { createBannerPlanes, type BannerPlanes } from './banner-plane.js';
import { createWrecks, type Wrecks } from './wrecks.js';
import type { SpotQuery } from '../../game/fishing/spot.js';
import { createHotspotWorld, type HotspotWorld, type GullSite } from './hotspots.js';
import { createFishingBuddy, type FishingBuddy } from './buddy.js';
import { createLuigiMode, type LuigiMode } from './luigi.js';
import { createCaelen, type Caelen, type CaelenDiverInput, type CaelenShotResult } from './caelen.js';
import { createPartyBoats, type PartyBoats } from './party-boats.js';
import { createBoatGulls, type BoatGulls } from './boat-gulls.js';
import { birdWorldPos, shootDownBird, type Bird } from './seabirds.js';
import { createCarcasses, BIRD_REPLACE_S, type Carcasses } from './carcass.js';
import { ampFor, waveHBase } from '@keysrun/shared/waves';
import { depthAt } from '@keysrun/shared/world/depth';
import type { Carcass } from '@keysrun/shared/sim/chum';
import { createDog, type Dog } from './dog.js';
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
  /** One short bark for the boat dog (entities/life/dog.ts). Optional — omit it and the dog is
   * silent; this module owns no audio of its own. */
  dogBark?(): void;
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
  /** VERIFICATION ONLY: the banner plane currently overhead, and a way to summon one. */
  bannerPlanes: BannerPlanes;
  toggleBuddy(): void;
  isBuddyOn(): boolean;
  /** Tests one resolved spear shot against Caelen and applies his reaction — see
   * entities/life/caelen.ts's `resolveSpearShot`. `game/world.ts` calls this with the same ray it
   * already captures for the fish near-miss spook. */
  caelenShot(p1: { x: number; y: number; z: number }, p2: { x: number; y: number; z: number }): CaelenShotResult;
  /** Every bird the boat pistol may shoot at (gulls following the boat, pelicans, the bait-ball
   * and weedline birds). NOT Caelen: he owns his own capsule and reaction, reached through
   * `caelenShot`. Rebuilt per call - call it per shot, not per frame. */
  shootableBirds(): Bird[];
  /**
   * Shoot one bird down: it goes limp, tumbles, hits the water, and leaves a floating carcass that
   * draws the big predatory species in (entities/life/carcass.ts, `@keysrun/shared/sim/chum`).
   * Replaces the plain `scareBird` the pistol used to apply to a struck bird — a hit that only
   * scattered the flock was the end of the story, and the carcass is the story.
   *
   * Nothing is spawned here: the fall runs for a second or so and the carcass appears when the
   * body actually reaches the water, so that the splash, the carcass and the sound all happen at
   * the same moment rather than at the moment of the hit.
   */
  shootBird(B: Bird): void;
  /**
   * Dead birds currently floating, for `entities/fish`'s `update` (where `chumPull` turns them
   * into an attraction). Pure state, no three.js — the mirror image of the `Threat[]` the same
   * call already takes.
   */
  carcasses(): readonly Carcass[];
  /** Seconds until Caelen comes back, 0 when he's here. */
  caelenAwayFor(): number;
  /** VERIFICATION-ONLY: where the boat dog is standing and what it's doing. */
  dogState(): ReturnType<Dog['debugState']>;
  /** VERIFICATION-ONLY: Caelen's live capsule, or null while he's away. */
  caelenDebugHitbox(): ReturnType<Caelen['debugHitbox']>;
  /** VERIFICATION-ONLY: every floating carcass with the potency the chum rules give it. */
  carcassDebug(): ReturnType<Carcasses['debug']>;
  /** VERIFICATION-ONLY: put a carcass in the water at a chosen point, without a bird or a bullet
   * — the fish side of this has to be testable without first landing a pistol shot on a live gull
   * that happens to be flying over the right school. */
  carcassDebugDrop(x: number, z: number): Carcass | null;
  /** VERIFICATION-ONLY: jump the carcass clock. See `Carcasses.debugAge`. */
  carcassDebugAge(seconds: number): void;
  /** One-time arrays for `stubs.ts`'s `installWorldLife` — see this module's header, point 4. */
  legacySnapshot(): { rigs: ReadonlyArray<unknown>; weeds: ReadonlyArray<unknown>; hotspots: ReadonlyArray<unknown>; traffic: ReadonlyArray<unknown>; racers: ReadonlyArray<unknown> };
  /** VERIFICATION ONLY: where the working fleet is. */
  commercialDebug(): ReturnType<CommercialFleet['debug']>;
  dispose(): void;
}

export function createLifeSystems(scene: THREE.Scene, boatSpawn: { x: number; z: number }, deps: LifeDeps): LifeSystems {
  const racerFleet: RacerFleet = createRacerFleet(scene);
  const trafficFleet: TrafficFleet = createTrafficFleet(scene);
  // The working fleet — trap boats, trawlers and a troller (entities/life/commercial.ts).
  const commercial: CommercialFleet = createCommercialFleet(scene);
  const pelicans: PelicanFlocks = createPelicanFlocks(scene, boatSpawn);
  // Somebody is always towing a banner up the Keys. It is the only thing out on the water that
  // advertises the town, which otherwise you have to already know about to visit.
  const bannerPlanes: BannerPlanes = createBannerPlanes(scene);
  const hotspotWorld: HotspotWorld = createHotspotWorld(scene, deps.lightMats);
  const buddy: FishingBuddy = createFishingBuddy(scene, deps);
  const luigi: LuigiMode = createLuigiMode({ hypeCallout: deps.hypeCallout, particles: deps.particles });
  const caelen: Caelen = createCaelen(scene, { sayCaelenLine: deps.sayCaelenLine });
  const partyBoats: PartyBoats = createPartyBoats(scene);
  const boatGulls: BoatGulls = createBoatGulls(scene, boatSpawn);
  // The dog belongs to the player, not to the hull, so it is built here once and re-parents
  // itself to whatever boat model it is handed — switching boats rebuilds the model entirely.
  const dog: Dog = createDog({ bark: deps.dogBark });
  const carcasses: Carcasses = createCarcasses(scene);
  /** Last `update` sim time. `shootBird` is called from the pistol, outside the frame loop, and
   * needs a clock to sample the wave height at; this is the same `t` every other bird system in
   * here is already being stepped with. */
  let lastT = 0;
  const wrecks: Wrecks = createWrecks(scene);
  // DEV/VERIFICATION HOOK ONLY (same convention as __fishDebug): where the wrecks are and which
  // draw tier / chart state each is in. No normal code path reads it.
  (globalThis as unknown as { __wreckDebug?: unknown }).__wreckDebug = () => wrecks.debug();
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
      lastT = t;
      const cameraXZ = { x: camera.position.x, z: camera.position.z };
      racerFleet.update(dt, t, boat, cameraXZ, deps.particles);
      trafficFleet.update(dt, t, boat, cameraXZ, deps.particles);
      commercial.update(dt, t, cameraXZ);
      pelicans.update(dt, t, boat, cameraXZ, deps.particles);
      bannerPlanes.update(dt, t, boat, cameraXZ);
      hotspotWorld.update(dt, t, boat, cameraXZ, deps.particles);
      buddy.update(dt, t, boat, playerBoatId, camera, viewport, deps.particles);
      caelen.update(dt, t, boat, camera, viewport, inputs.diver ?? null);
      boatGulls.update(dt, t, boat);
      // A fish coming over the gunwale is the dog's whole day.
      dog.update(dt, t, model, boatLen, boat, fishCaught);
      partyBoats.update(dt, t, camera.position, deps.particles, deps.currentTodK);
      wrecks.update(dt, camera.position, boat, inputs.diver ?? null);
      // After every bird system above has had its frame: a falling bird's splash callback spawns
      // a carcass through `carcasses.spawn`, so stepping the carcasses last means one that landed
      // this frame starts at age 0 rather than being aged by a dt it did not exist for.
      carcasses.update(dt, t);
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
      nearWreck: (x, z) => wrecks.nearWreck(x, z),
    },
    partySites(): readonly PartySite[] { return partyBoats.sites(); },
    pirateSite(): PirateSite | null { return pirates.site(); },
    isLuigiOn(): boolean { return luigi.isOn(); },
    bannerPlanes,
    toggleBuddy(): void { buddy.toggle(); },
    isBuddyOn(): boolean { return buddy.isOn(); },
    caelenShot(p1, p2): CaelenShotResult { return caelen.resolveSpearShot(p1, p2); },
    shootableBirds(): Bird[] { return [...boatGulls.birds(), ...pelicans.birds(), ...hotspotWorld.birds()]; },
    shootBird(B: Bird): void {
      // The surface height is sampled under the bird NOW rather than under the splash point: the
      // bird has not landed yet, and over the 10-30 m it drifts while falling the wave field only
      // differs by a few centimetres of swell. seabirds.ts converts it into the bird's own
      // parent-local frame (see `shootDownBird`).
      const p = birdWorldPos(B);
      const surf = waveHBase(p.x, p.z, lastT, ampFor(depthAt(p.x, p.z)));
      shootDownBird(B, surf, BIRD_REPLACE_S, (x, _y, z) => {
        carcasses.spawn(B.kind, x, z);
        deps.particles.splash(x, z, 8, 0.7);
      });
    },
    carcasses(): readonly Carcass[] { return carcasses.list(); },
    caelenAwayFor(): number { return caelen.awayFor(); },
    dogState() { return dog.debugState(); },
    caelenDebugHitbox() { return caelen.debugHitbox(); },
    carcassDebug() { return carcasses.debug(); },
    carcassDebugDrop(x, z) { return carcasses.spawn('gull', x, z); },
    carcassDebugAge(seconds) { carcasses.debugAge(seconds); },
    legacySnapshot() {
      return {
        rigs: hotspotWorld.listRigs(), weeds: hotspotWorld.listWeeds(), hotspots: hotspotWorld.listHotspots(),
        traffic: trafficFleet.listTraffic(), racers: racerFleet.listRacers(),
      };
    },
    commercialDebug: () => commercial.debug(),
    dispose(): void {
      commercial.dispose();
      luigi.dispose();
      caelen.dispose();
      boatGulls.dispose();
      partyBoats.dispose();
      dog.dispose();
      wrecks.dispose();
      carcasses.dispose();
      pirates.dispose();
      buddy.dispose();
      bannerPlanes.dispose();
    },
  };
}
