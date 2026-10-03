/**
 * `initWorld()`: the explicit, ordered boot sequence — see docs/ARCHITECTURE.md requirement 4
 * ("module top level stays declaration-only; export an explicit initWorld() calling build steps
 * in today's order. Do not rely on import side effects.").
 *
 * This mirrors legacy/index.html's top-to-bottom script evaluation order: renderer/scene/sky →
 * water → seafloor → islands → bridge → landmarks → coral → clouds → particles → marinas →
 * boat/electronics → camera/input → HUD/minimap → start screen → placement. Every module it
 * calls is declaration-only at its own top level (no import-time side effects) — all building
 * happens inside the `create*`/`make*` calls below, in this order.
 */
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { WORLD, WB } from '@keysrun/shared/world/depth';
import { BOATS, SPEED_SCALE, type Boat } from '@keysrun/shared/content/boats';
import { SEA_STATES } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { createBoatState, stepBoat, type BoatState, type BoatEnv, type DockRect, type Piling, type SimEvent } from '@keysrun/shared/sim/boat';

import { createScene, isTouch } from '../core/scene.js';
import { createTimeOfDay } from '../core/time-of-day.js';
import { probeGpu, detectDefaultTier, loadSavedTier, saveTier, getQualitySettings, QUALITY_TIERS, type QualityTier, type QualitySettings } from '../core/quality.js';
import { createCascadedShadows } from '../core/shadows.js';
import { createPostFX } from '../core/postfx.js';
import { createProfiler } from '../ui/profiler.js';
import { createWater } from '../world/water.js';
import { createSeafloor } from '../world/seafloor.js';
import { createIslands } from '../world/islands.js';
import { createBridge } from '../world/bridge.js';
import { createLandmarks } from '../world/landmarks.js';
import { createCoral } from '../world/coral.js';
import { createFishWorld } from '../entities/fish/index.js';
import { createClouds } from '../world/clouds.js';
import { createMarinas } from '../world/marinas.js';
import { createParticleSystem } from '../world/particles.js';

import { makeBoat, type BoatModel } from '../entities/boat/model.js';
import { createElectronics, type BoatReadout } from '../entities/boat/electronics.js';
import { applyBoatVisuals, sampleWaterHeight } from '../entities/boat/visuals.js';
import { createBoatInput, bindBoatInput, type BoatStateBox } from '../entities/boat/input.js';
import { createCamState, createFpState, updateCamera, cycleView, bindCameraPointerControls } from '../entities/camera.js';

import { updateHUD } from '../ui/hud.js';
import { createMinimap } from '../ui/minimap.js';
import { populateBoatCards, showHud, showStart } from '../ui/start.js';
import { toast } from '../ui/toast.js';
import { spotClear, findClearSpot } from '../state/game.js';
import { SPAWN_X, SPAWN_DZ, SPAWN_H } from '../state/constants.js';

const DT = 1 / 30;

const lerpN = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Shortest-path angle interpolation, so a heading crossing the ±π seam doesn't spin the long way. */
const lerpAngle = (a: number, b: number, t: number): number => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
};

export interface World {
  resize(): void;
  frame(dt: number): void;
  renderer: THREE.WebGLRenderer;
}

function hullOf(spec: Boat) {
  return { len: spec.len, beam: spec.beam, top: spec.top, accel: spec.accel, turn: spec.turn, draft: spec.draft, cat: spec.cat };
}

export function initWorld(wrap: HTMLElement): World {
  // 1. renderer / scene / sky / lighting
  const sceneCtx = createScene(wrap);
  const { renderer, scene, camera, sunDir } = sceneCtx;

  // 1b. quality tier: a saved choice wins, otherwise auto-detect from a quick GPU probe
  // (docs/ARCHITECTURE.md Part 2 "Quality tiers" — Low must run on an integrated GPU).
  const gpuProbe = probeGpu(renderer.getContext());
  let quality = getQualitySettings(loadSavedTier() ?? detectDefaultTier(gpuProbe));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  (scene.fog as THREE.Fog).far = quality.fogFar;

  // 2. water (+ the shared depth-grid cache it reads)
  const water = createWater(sunDir, quality.waterSegments);
  scene.add(water.water);

  // 3. time of day (depends on scene + water's sky-colour uniform)
  const tod = createTimeOfDay(sceneCtx, water.uniforms.uSky);

  // 4. sea floor
  scene.add(createSeafloor(WORLD.x0, WORLD.z0, WORLD.size));

  // 5. islands + vegetation + runway
  const islands = createIslands();
  scene.add(islands.group);

  // 6. US-1 / Seven Mile Bridge
  const bridge = createBridge();
  scene.add(bridge.group);

  // 7. landmarks (Sombrero light, Faro Blanco, reef moorings)
  scene.add(createLandmarks());

  // 8. coral
  scene.add(createCoral());

  // 8b. fish — schools of VIS creatures, deterministic resident reef schools plus a roaming
  // layer (entities/fish/index.ts); see docs/ARCHITECTURE.md "Fish at realism *and* density" and
  // "Fish ownership — three tiers". `fishWorld.update` is called from frame() below with the
  // boat as the only threat for now — a diver threat can be appended to the optional 4th arg
  // once entities/diver/** exists, with no change needed inside entities/fish.
  const fishWorld = createFishWorld();
  scene.add(fishWorld.group);

  // 9. clouds (one InstancedMesh — see world/clouds.ts header; count fixed at boot per the
  // initial quality tier since, being a single draw call either way, it isn't worth a rebuild
  // on every quality change the way water tessellation or shadows are).
  const clouds = createClouds(quality.cloudInstances);
  scene.add(clouds.group);
  tod.setCloudMat(clouds.material);

  // 10. marinas / docks / mooring field / golf
  const marinas = createMarinas();
  scene.add(marinas.group);

  // 11. particles (wake + spray)
  const particles = createParticleSystem(renderer.getPixelRatio());
  scene.add(particles.points);

  // 12. boat + electronics
  const pilings: Piling[] = bridge.pilings;
  const dockRects: DockRect[] = marinas.dockRects;

  const readout: BoatReadout = { x: 0, z: 0, h: 0, speed: 0 };
  const electronics = createElectronics(readout);

  let boatSpec: Boat = BOATS[1]; // legacy's default `let boatSpec = BOATS[1]` (the Grady-White)
  let model: BoatModel = makeBoat(boatSpec, { lightMats: tod.lightMats, todK: tod.getK(), mfdTex: electronics.mfdTex, gpsTex: electronics.gpsTex, sonTex: electronics.sonTex });
  scene.add(model.group);

  const spawnZ = chainZ(SPAWN_X) + SPAWN_DZ;
  const spot = findClearSpot(SPAWN_X, spawnZ, { draft: boatSpec.draft, len: boatSpec.len, dockRects, pilings }, { x: SPAWN_X, z: spawnZ });
  let curState: BoatState = createBoatState(spot.x, spot.z, SPAWN_H);
  model.group.position.set(curState.x, curState.y, curState.z);

  // 12b. cascaded shadows + post-processing (docs/ARCHITECTURE.md Part 2 items 2 and 5). Built
  // after every other scene.add() above so applyToSubtree's one traversal catches everything —
  // see core/shadows.ts's header for why the water material needs the separate registration call.
  const shadowKey = (s: QualitySettings['shadows']): string => `${s.enabled}:${s.cascades}:${s.mapSize}:${s.maxFar}`;
  let shadows = createCascadedShadows(camera, scene, sunDir, quality.shadows);
  let curShadowKey = shadowKey(quality.shadows);
  shadows.registerCustomMaterial(water.material, water.baseOnBeforeCompile);
  shadows.registerCustomMaterial(islands.frondMaterial, islands.frondBaseCompile);
  shadows.applyToSubtree(scene);
  let postfx = createPostFX(renderer, scene, camera, quality.post);
  const profiler = createProfiler();
  // The postprocessing composer issues several internal renderer.render() calls per frame
  // (RenderPass, an optional NormalPass for SSAO, the final EffectPass blit); with autoReset left
  // on, renderer.info resets on each of those and profiler.sample would only ever see the last
  // (tiny, full-screen-quad) one. Reset it ourselves once per frame instead, right before
  // postfx.render(), so the counts profiler.sample reads after are the frame's real total.
  renderer.info.autoReset = false;

  function setQualityLabels(tier: QualityTier, announce: boolean): void {
    const Tier = tier[0].toUpperCase() + tier.slice(1);
    const b1 = document.getElementById('btnQuality'); if (b1) b1.textContent = '⚙ ' + Tier;
    const b2 = document.getElementById('btnQualityStart'); if (b2) b2.textContent = 'Quality: ' + Tier;
    if (announce) toast('Quality: ' + Tier);
  }
  function applyQuality(tier: QualityTier, announce = true): void {
    quality = getQualitySettings(tier);
    saveTier(tier);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    (scene.fog as THREE.Fog).far = quality.fogFar;
    water.setTessellation(quality.waterSegments);
    // Only tear down and recreate the CSM lights if their shape actually changed. Disposing and
    // recreating DirectionalLights bumps three's internal light-state version even when the
    // resulting light *count* is unchanged (e.g. Medium -> High are both 1 cascade), which can
    // desync a material's cached WebGLProgram from its uniforms for one frame — rebuilding only
    // when something shadow-relevant truly changed avoids that churn entirely in the common case.
    const nextShadowKey = shadowKey(quality.shadows);
    if (nextShadowKey !== curShadowKey) {
      curShadowKey = nextShadowKey;
      shadows.dispose();
      shadows = createCascadedShadows(camera, scene, sunDir, quality.shadows);
      shadows.registerCustomMaterial(water.material, water.baseOnBeforeCompile);
      shadows.registerCustomMaterial(islands.frondMaterial, islands.frondBaseCompile);
      shadows.applyToSubtree(scene);
      // Disposing+recreating the CSM's DirectionalLights bumps three's internal light-state
      // version even for materials whose own cache key doesn't change, which can (rarely) leave a
      // material's cached WebGLProgram attached with a stale uniforms object for one frame — see
      // this project's report. Forcing every material to forget its cached program (so the next
      // getProgram() call treats it as brand new and re-runs onBeforeCompile unconditionally)
      // closes that window entirely. `renderer.properties` is undocumented-but-public three
      // internals (WebGLProperties), hence the cast.
      const rendererProps = (renderer as unknown as { properties: { remove(o: THREE.Material): void } }).properties;
      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.InstancedMesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) rendererProps.remove(m);
      });
    }
    postfx.dispose();
    postfx = createPostFX(renderer, scene, camera, quality.post);
    resize();
    setQualityLabels(tier, announce);
  }
  setQualityLabels(quality.tier, false);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') profiler.toggle();
    if (e.code === 'KeyG') applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });
  document.getElementById('btnQuality')?.addEventListener('click', () => {
    applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });
  document.getElementById('btnQualityStart')?.addEventListener('click', () => {
    applyQuality(QUALITY_TIERS[(QUALITY_TIERS.indexOf(quality.tier) + 1) % QUALITY_TIERS.length]);
  });

  // 13. camera + input
  const camState = createCamState();
  const fpState = createFpState();
  bindCameraPointerControls(renderer.domElement, camState, fpState);

  const input = createBoatInput();
  const stateBox: BoatStateBox = { state: curState };

  let seaIdx = 1; // legacy's initial `seaIdx=1` ("Choppy")
  let sw = 0.9, ch = 1; // legacy's initial SW/CH (index.html:435)
  let game = { running: false };

  bindBoatInput(input, stateBox, {
    toggleTrim() {
      stateBox.state = { ...stateBox.state, trimMode: !stateBox.state.trimMode };
      input.fwd = false; input.back = false;
      toast(stateBox.state.trimMode ? 'Trim mode on — ▲ trims up, ▼ trims down. W/S still change throttle. T to exit.' : 'Trim mode off.');
    },
    shiftGear() {
      const next = ({ D: 'N', N: 'R', R: 'D' } as const)[stateBox.state.gear];
      stateBox.state = { ...stateBox.state, gear: next };
      toast('Gear: ' + next);
    },
    toggleEngine() {
      const on = !stateBox.state.engineOn;
      stateBox.state = { ...stateBox.state, engineOn: on };
      toast(on ? 'Firing them up…' : 'Motors off.');
    },
    toggleSunset() { tod.toggleSunset(); },
    toggleLights() {
      if (model.lights) { model.lights.visible = !model.lights.visible; toast('Underwater lights ' + (model.lights.visible ? 'on' : 'off') + '.'); }
      else toast('This boat has no underwater lights.');
    },
    cycleView() {
      const label = cycleView(fpState, model);
      toast(label + ' — press 1 to switch');
      const b = document.getElementById('btnCam');
      if (b) b.textContent = ['🎥 3rd', '🎥 Helm', '🎥 Tower'][fpState.view];
    },
    setSea(delta) {
      seaIdx = (seaIdx + delta + SEA_STATES.length) % SEA_STATES.length;
      const b = document.getElementById('btnSea');
      if (b) b.textContent = 'Sea: ' + SEA_STATES[seaIdx].n.toLowerCase();
      toast(SEA_STATES[seaIdx].n + ' — ' + SEA_STATES[seaIdx].d);
    },
    zoomChart(k) { electronics.zoom(k); },
    toggleBigChart() { document.getElementById('mapbox')?.classList.toggle('big'); },
    resetCamZoom() { camState.zoom = camState.zoom > 1.4 ? 1 : 1.9; },
  });

  // 14. HUD + minimap
  const minimap = createMinimap();

  // 15. start screen
  function placeBoat(spec: Boat): void {
    boatSpec = spec;
    scene.remove(model.group);
    model = makeBoat(spec, { lightMats: tod.lightMats, todK: tod.getK(), mfdTex: electronics.mfdTex, gpsTex: electronics.gpsTex, sonTex: electronics.sonTex });
    scene.add(model.group);
    shadows.applyToSubtree(model.group);
    const label = document.getElementById('gBoat');
    if (label) label.textContent = (spec.nickname ? '"' + spec.nickname + '" · ' : '') + spec.brand + ' ' + spec.name + ' · ' + spec.power;
  }
  function unstick(): void {
    const S = boatSpec;
    const okSpot = spotClear(stateBox.state.x, stateBox.state.z, { draft: S.draft, len: S.len, dockRects, pilings })
      ? { x: stateBox.state.x, z: stateBox.state.z }
      : findClearSpot(stateBox.state.x, stateBox.state.z, { draft: S.draft, len: S.len, dockRects, pilings }, { x: SPAWN_X, z: chainZ(SPAWN_X) + SPAWN_DZ });
    stateBox.state = createBoatState(okSpot.x, okSpot.z, stateBox.state.h);
    model.group.position.set(stateBox.state.x, stateBox.state.y, stateBox.state.z);
  }

  populateBoatCards(BOATS, boatSpec, {
    onSelectBoat(spec) { if (!game.running) placeBoat(spec); else boatSpec = spec; },
    onGo() {
      placeBoat(boatSpec);
      unstick();
      showHud();
      if (isTouch()) document.getElementById('touch')?.classList.remove('hidden');
      game.running = true;
      camState.yaw = 0;
      renderer.domElement.focus();
      toast('Head out and get a feel for the ' + boatSpec.name + '.');
    },
  });
  document.getElementById('btnMarina')?.addEventListener('click', () => {
    game.running = false;
    input.fwd = input.back = input.left = input.right = false;
    const lede = document.getElementById('lede');
    if (lede) lede.textContent = 'Switch boats any time.';
    const go = document.getElementById('btnGo');
    if (go) go.textContent = 'Back on the water';
    showStart();
    document.getElementById('touch')?.classList.add('hidden');
  });

  // 16. placement (already done above, before camera/input bind, mirroring legacy's
  // `placeBoat(boatSpec); unstick();` which ran right after the boat was first built)

  let simTime = 0;
  let acc = 0;
  let prevState: BoatState = curState;

  function fixedStep(dt: number): SimEvent[] {
    const st = SEA_STATES[seaIdx], k = Math.min(1, dt * 0.5);
    sw += (st.sw - sw) * k; ch += (st.ch - ch) * k;

    simTime += dt;
    const env: BoatEnv = {
      t: simTime, hull: hullOf(boatSpec), sw, ch, worldBounds: WB, pilings, dockRects,
      canDrive: game.running, fightActive: false, fightTarget: null, lineOut: false, luigiOn: false,
    };
    const next = stepBoat(stateBox.state, input, env, dt);
    stateBox.state = next;
    return next.events;
  }

  function frame(dt: number): void {
    const clamped = Math.min(0.05, dt);
    acc += clamped;
    let steps = 0;
    const events: SimEvent[] = [];
    while (acc >= DT && steps < 5) {
      prevState = stateBox.state;
      events.push(...fixedStep(DT));
      acc -= DT;
      steps++;
    }
    curState = stateBox.state;

    // Render interpolates the leftover fraction of a step (docs/ARCHITECTURE.md requirement 2):
    // only the smoothly-varying transform fields are blended between the last two completed
    // physics states; discrete/authoritative fields (gear, wakeRing, trim mode, …) always come
    // from the latest one. This is the standard fixed-timestep interpolation trade-off — render
    // lags the simulation by at most one DT (≤33 ms), never extrapolates.
    const alpha = Math.max(0, Math.min(1, acc / DT));
    const renderState: BoatState = alpha === 0 ? curState : {
      ...curState,
      x: lerpN(prevState.x, curState.x, alpha),
      z: lerpN(prevState.z, curState.z, alpha),
      y: lerpN(prevState.y, curState.y, alpha),
      pitch: lerpN(prevState.pitch, curState.pitch, alpha),
      roll: lerpN(prevState.roll, curState.roll, alpha),
      h: lerpAngle(prevState.h, curState.h, alpha),
    };

    readout.x = curState.x; readout.z = curState.z; readout.h = curState.h; readout.speed = curState.speed;

    water.recenter(renderState.x, renderState.z);
    water.update(simTime, Math.max(sw * 1.1, ch), sw, ch);
    islands.update(simTime);
    tod.update(clamped);
    fishWorld.update(clamped, simTime, { x: curState.x, z: curState.z }, Math.abs(curState.speed));

    const amp = ampAt(renderState.x, renderState.z);
    applyBoatVisuals(renderState, model, { t: simTime, dt: clamped, todK: tod.getK(), sw, ch, amp, hull: { len: boatSpec.len, beam: boatSpec.beam, topMs: boatSpec.top * 0.5144 * SPEED_SCALE }, particles, water }, events);

    particles.update(clamped, simTime, (x, z, t, a) => sampleWaterHeight(curState, x, z, t, a, sw, ch));

    for (const b of marinas.dockBoats) {
      b.position.y = sampleWaterHeight(curState, b.position.x, b.position.z, simTime, ampAt(b.position.x, b.position.z), sw, ch) - 0.05;
    }

    updateCamera(clamped, { camera, sky: sceneCtx.sky, sunDisc: sceneCtx.sunDisc, sunDir }, camState, fpState, model, renderState, game.running, boatSpec.len);
    electronics.update(clamped, simTime, fpState.driveOn);
    if (game.running) {
      updateHUD(clamped, curState, { boatLabel: hudBoatLabel(boatSpec), draft: boatSpec.draft, running: game.running });
      minimap.draw(simTime, curState);
    }

    // Cascades reposition from the camera's up-to-date matrix (updateCamera just finalized it)
    // and the sun's current colour/intensity (time-of-day.ts mutated sceneCtx.sun above).
    shadows.setLight(sceneCtx.sun.color, sceneCtx.sun.intensity);
    shadows.update(sunDir);
    // Cheap (a handful of Box3/uniform updates) and keeps the per-material cameraNear/shadowFar
    // uniforms in sync with camera.near, which toggles between drive views (entities/camera.ts).
    shadows.updateFrustums();
    renderer.info.reset();
    postfx.render(clamped);
    // Real elapsed frame time (`dt`, pre-physics-clamp), not `clamped` — the latter is hard-capped
    // at 50 ms for the physics accumulator and would make the HUD misreport every real frame
    // slower than 20 fps as exactly 20 fps.
    profiler.sample(dt, renderer, quality.tier);
  }

  function resize(): void {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postfx.setSize(w, h);
    shadows.updateFrustums();
  }

  return { resize, frame, renderer };

  function hudBoatLabel(spec: Boat): string {
    return (spec.nickname ? '"' + spec.nickname + '" · ' : '') + spec.brand + ' ' + spec.name + ' · ' + spec.power;
  }
}
