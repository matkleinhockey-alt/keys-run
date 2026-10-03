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
import { createWater } from '../world/water.js';
import { createSeafloor } from '../world/seafloor.js';
import { createIslands } from '../world/islands.js';
import { createBridge } from '../world/bridge.js';
import { createLandmarks } from '../world/landmarks.js';
import { createCoral } from '../world/coral.js';
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

  // 2. water (+ the shared depth-grid cache it reads)
  const water = createWater(sunDir);
  scene.add(water.water);

  // 3. time of day (depends on scene + water's sky-colour uniform)
  const tod = createTimeOfDay(sceneCtx, water.uniforms.uSky);

  // 4. sea floor
  scene.add(createSeafloor(WORLD.x0, WORLD.z0, WORLD.size));

  // 5. islands + vegetation + runway
  scene.add(createIslands());

  // 6. US-1 / Seven Mile Bridge
  const bridge = createBridge();
  scene.add(bridge.group);

  // 7. landmarks (Sombrero light, Faro Blanco, reef moorings)
  scene.add(createLandmarks());

  // 8. coral
  scene.add(createCoral());

  // 9. clouds
  const clouds = createClouds();
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
    tod.update(clamped);

    const amp = ampAt(renderState.x, renderState.z);
    applyBoatVisuals(renderState, model, { t: simTime, dt: clamped, todK: tod.getK(), sw, ch, amp, hull: { len: boatSpec.len, beam: boatSpec.beam, topMs: boatSpec.top * 0.5144 * SPEED_SCALE }, particles, water }, events);

    particles.update(clamped, simTime, (x, z, t, a) => sampleWaterHeight(curState, x, z, t, a, sw, ch));

    for (const b of marinas.dockBoats) {
      b.position.y = sampleWaterHeight(curState, b.position.x, b.position.z, simTime, ampAt(b.position.x, b.position.z), sw, ch) - 0.05;
    }

    updateCamera(clamped, { camera, sky: sceneCtx.sky, sunDisc: sceneCtx.sunDisc, sun: sceneCtx.sun, sunDir }, camState, fpState, model, renderState, game.running, boatSpec.len);
    electronics.update(clamped, simTime, fpState.driveOn);
    if (game.running) {
      updateHUD(clamped, curState, { boatLabel: hudBoatLabel(boatSpec), draft: boatSpec.draft, running: game.running });
      minimap.draw(simTime, curState);
    }

    renderer.render(scene, camera);
  }

  function resize(): void {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { resize, frame, renderer };

  function hudBoatLabel(spec: Boat): string {
    return (spec.nickname ? '"' + spec.nickname + '" · ' : '') + spec.brand + ' ' + spec.name + ' · ' + spec.power;
  }
}
