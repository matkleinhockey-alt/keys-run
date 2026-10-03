/**
 * The hooked-fish mesh, fishing line and bobber (legacy index.html:2601-2626, 2812-2823), plus
 * `aimRod` (legacy index.html:2727-2736) which points the rod at the bobber/fish and picks
 * which gunwale station to fish from.
 *
 * See fish-mesh.ts's header for why the hooked fish is a generic body rather than `VGEO[key]`.
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { sampleWaterHeight } from '../../entities/boat/visuals.js';
import { clamp, lerp } from '../../core/math.js';
import { makeFishMesh } from './fish-mesh.js';
import { F } from './state.js';

const LSEG = 28;

export interface FishingVisuals {
  fishLine: THREE.Line;
  bobber: THREE.Group;
  showHooked(color: string, lenM: number): void;
  hideHooked(): void;
  updateHooked(t: number, dt: number, running: boolean, shake: number, deep: number, airborne: boolean): void;
  drawLine(t: number, boat: BoatState, sw: number, ch: number, rodTipWorld: THREE.Vector3): void;
  aimRod(model: BoatModel, target: THREE.Vector3, fightActive: boolean, tension: number): void;
  dispose(): void;
}

const angLerp = (a: number, b: number, t: number): number => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * clamp(t, 0, 1);
};

export function createFishingVisuals(scene: THREE.Scene): FishingVisuals {
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LSEG + 1) * 3), 3));
  const fishLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
  fishLine.frustumCulled = false;
  fishLine.renderOrder = 3;
  fishLine.visible = false;
  scene.add(fishLine);

  const bobber = new THREE.Group();
  {
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe4572e }));
    top.position.y = 0.12;
    bobber.add(top);
    const bot = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    bot.position.y = -0.1;
    bobber.add(bot);
  }
  bobber.visible = false;
  scene.add(bobber);

  let hookMesh: THREE.Group | null = null;
  let hookH = 0, hookPX = 0, hookPZ = 0;
  let airElapsed = 0, wasAirborne = false;
  const AIR_VISUAL_DUR = 1.0; // fixed cosmetic hop duration — independent of the sim's exact airT

  function showHooked(color: string, lenM: number): void {
    hideHooked();
    hookMesh = makeFishMesh(color, lenM);
    hookPX = F.fx; hookPZ = F.fz;
    scene.add(hookMesh);
  }
  function hideHooked(): void {
    if (hookMesh) { scene.remove(hookMesh); hookMesh = null; }
  }
  function updateHooked(t: number, dt: number, running: boolean, shake: number, deep: number, airborne: boolean): void {
    if (!hookMesh) return;
    const dx = F.fx - hookPX, dz = F.fz - hookPZ;
    if (Math.hypot(dx, dz) > 0.005) hookH = angLerp(hookH, Math.atan2(-dx, -dz), 0.15);
    hookPX = F.fx; hookPZ = F.fz;
    const base = -0.6 - deep;
    // airborne: a simple hop (no separate jump mesh/arc — see fish-mesh.ts header) peaking at
    // mid-jump, tilted up on the way out and down on the way back. Timed by a small local
    // elapsed-since-airborne-started counter rather than the sim's exact `airT` countdown, which
    // only this cosmetic curve needs — see createFightState/stepFight in sim/fight.ts.
    if (airborne && !wasAirborne) airElapsed = 0;
    if (airborne) airElapsed += dt;
    wasAirborne = airborne;
    const airFrac = clamp(airElapsed / AIR_VISUAL_DUR, 0, 1);
    const hop = airborne ? Math.sin(airFrac * Math.PI) * 1.4 : 0;
    hookMesh.position.set(F.fx, base + hop, F.fz);
    const pitch = airborne ? -(airFrac < 0.5 ? 1 : -1) * 0.6 : -0.1;
    hookMesh.rotation.set(
      pitch,
      hookH + Math.sin(t * (running ? 16 : 8)) * (running ? 0.2 : 0.1) + Math.sin(t * 38) * shake * 0.9,
      Math.sin(t * 3) * 0.15 + Math.sin(t * 31) * shake * 0.8,
      'YXZ',
    );
  }

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function drawLine(t: number, boat: BoatState, sw: number, ch: number, rodTipWorld: THREE.Vector3): void {
    fishLine.visible = true;
    tmpA.copy(rodTipWorld);
    const isFight = F.state === 'fight';
    const bx = isFight ? F.fx : F.bob.x;
    const bz = isFight ? F.fz : F.bob.z;
    const by = isFight ? sampleWaterHeight(boat, F.fx, F.fz, t, 0, sw, ch) + 0.05 : F.bob.y;
    tmpB.set(bx, by, bz);
    const tension = F.fight ? F.fight.tension : 0;
    const sag = isFight ? (1 - clamp(tension, 0, 1)) * 2.5 : F.state === 'casting' ? 0 : 2;
    const arr = lineGeo.attributes.position.array as Float32Array;
    for (let i = 0; i <= LSEG; i++) {
      const u = i / LSEG;
      arr[i * 3] = lerp(tmpA.x, tmpB.x, u);
      arr[i * 3 + 1] = lerp(tmpA.y, tmpB.y, u) - Math.sin(u * Math.PI) * sag * u;
      arr[i * 3 + 2] = lerp(tmpA.z, tmpB.z, u);
    }
    lineGeo.attributes.position.needsUpdate = true;
    bobber.position.set(F.bob.x, F.bob.y, F.bob.z);
  }

  const tmpLocal = new THREE.Vector3();
  function aimRod(model: BoatModel, target: THREE.Vector3, fightActive: boolean, tension: number): void {
    const piv = model.rodPivot;
    tmpLocal.copy(target);
    model.group.worldToLocal(tmpLocal);
    let best = model.station, bs = -9;
    model.stations.forEach((st, i) => {
      const dx = tmpLocal.x - st.pos.x, dz = tmpLocal.z - st.pos.z, l = Math.hypot(dx, dz) || 1;
      const d = (dx * st.out.x + dz * st.out.z) / l + (i === model.station ? 0.3 : 0);
      if (d > bs) { bs = d; best = i; }
    });
    if (best !== model.station) { model.station = best; model.fishSpot.copy(model.stations[best].spot); }
    const st = model.stations[model.station];
    piv.position.copy(st.pos);
    const outYaw = Math.atan2(-st.out.x, -st.out.z);
    const yaw = Math.atan2(-(tmpLocal.x - st.pos.x), -(tmpLocal.z - st.pos.z));
    const d = clamp(((yaw - outYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI, -1.15, 1.15);
    piv.rotation.y = outYaw + d;
    piv.rotation.x = -(fightActive ? 1.0 + clamp(tension, 0, 1) * 0.3 : 0.85);
  }

  function dispose(): void {
    hideHooked();
    scene.remove(fishLine);
    scene.remove(bobber);
  }

  return { fishLine, bobber, showHooked, hideHooked, updateHooked, drawLine, aimRod, dispose };
}
