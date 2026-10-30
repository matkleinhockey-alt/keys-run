/**
 * The tournament ceremony: ten seconds on the planks at Boot Key Harbor City Marina. The winner
 * on the podium with the trophy over their head, the five fish that won it hung on a rack under
 * the champion's banner, a crowd going wild, confetti — and the camera's three shots of it
 * (`shot`), which the mode hands to game/world.ts for the ceremony's duration.
 *
 * Built on the same parts as the dockside weigh station (entities/land/dock-celebration.ts — its
 * spot finder picks the planks, and the crowd/fish/sign are made the same way), but it is its own
 * scene: that one celebrates *your* biggest fish when you step ashore; this one is for whoever won,
 * on everyone's screen at once.
 *
 * The display stays standing after the ten seconds (the crowd and confetti go), like the weigh
 * station's fish does, until the next tournament's ceremony replaces it.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { PAD, PAD_Y, TOWN_FRAME, groundAt, toWorld } from '@keysrun/shared/world/town';
import { makeHuman, type Human } from '../../entities/life/human.js';
import { beamBetween } from '../../entities/boat/hull.js';
import { makeFishMesh } from '../fishing/fish-mesh.js';

export interface CeremonyInfo {
  name: string;
  boat: string;
  species: readonly string[];
  /** lb per species; 0 = unknown (an online winner's own weights are always sent, so this is rare). */
  weights: readonly number[];
  /** The captain's look: an AI captain wears a cap and a work shirt. */
  captain: boolean;
}

export interface Shot { pos: THREE.Vector3; look: THREE.Vector3 }

const GOLD = 0xf2c14e;
const SKINS = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0xffdbac, 0x6b4226];
const SHIRTS = [0xffffff, 0x2f8fd8, 0xf26b5b, 0x3fb68b, 0xf4c542, 0x8a5cc2, 0xff8c42, 0x9ad0ec];
const pick = <T,>(a: readonly T[], i: number): T => a[((i % a.length) + a.length) % a.length];
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const FEET_L = V(-0.105, 0.085, 0), FEET_R = V(0.105, 0.085, 0);
const _hl = new THREE.Vector3(), _hr = new THREE.Vector3();

function makeTrophy(): THREE.Group {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, metalness: 0.95, roughness: 0.22 });
  // Cup profile, revolved: foot, stem, knop, bowl flaring to the lip.
  const prof = [[0.0, 0], [0.09, 0], [0.09, 0.02], [0.03, 0.04], [0.025, 0.12], [0.045, 0.14], [0.025, 0.16], [0.05, 0.2], [0.11, 0.3], [0.13, 0.4], [0.12, 0.41]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 28), gold));
  for (const sx of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 8, 18, Math.PI * 1.2), gold);
    h.position.set(sx * 0.13, 0.32, 0);
    h.rotation.z = sx > 0 ? -Math.PI * 0.6 : Math.PI * 1.6;
    g.add(h);
  }
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.2), new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.6 }));
  plinth.position.y = -0.03;
  g.add(plinth);
  return g;
}

function textPlane(lines: Array<[string, string, string]>, w: number, h: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = Math.round(1024 * (h / w));
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d2a44'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#f4c542'; g.lineWidth = 14; g.strokeRect(10, 10, c.width - 20, c.height - 20);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const step = c.height / (lines.length + 1);
  lines.forEach(([font, color, text], i) => { g.font = font; g.fillStyle = color; g.fillText(text, c.width / 2, step * (i + 1), c.width - 60); });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
}

interface Fan { h: Human; base: THREE.Vector3; cheer: boolean }

export function createCeremony(deps: { scene: THREE.Scene; onBuilt(root: THREE.Object3D): void }) {
  let display: THREE.Group | null = null;
  let party: THREE.Group | null = null;
  let winner: Human | null = null;
  let trophy: THREE.Object3D | null = null;
  let fans: Fan[] = [];
  let confetti: THREE.InstancedMesh | null = null;
  let conf: Array<{ p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; spin: number }> = [];
  // Ceremony frame: origin at the podium, +x toward the water (the crowd's side), +z along the rack.
  const origin = new THREE.Vector3();
  let yaw = 0;
  const local = (x: number, y: number, z: number): THREE.Vector3 => V(x, y, z).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw).add(origin);

  function dispose(root: THREE.Object3D | null): void {
    if (!root) return;
    deps.scene.remove(root);
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (!o.userData.keep) o.geometry.dispose();
      // The display fish's cloned, self-lit materials are this module's own.
      else if (o.material instanceof THREE.Material && o.material.userData.ceremonyOwned) o.material.dispose();
    });
  }

  function clear(): void {
    dispose(display); dispose(party);
    display = party = null; winner = null; trophy = null; fans = []; confetti = null; conf = [];
  }

  /**
   * Where the ceremony stands: the town's waterfront promenade at Boot Key Harbor City Marina
   * (world/town.ts's frame: `u` along the shore, `v` inland), facing the water. Off to one side of
   * the pier ramp — straight up the ramp is the town's welcome arch, which would stand in front of
   * the banner — and only where there's level pad all round for the crowd. No room anywhere and
   * there's no ceremony shot: the result still shows on the HUD.
   */
  function spot(): { x: number; z: number; y: number; face: { x: number; z: number } } | null {
    // West of the ramp first: east of it, at u = 16, other town structures stand over the spot.
    for (const u of [-16, -22, -28, 16, 22, 28]) {
      const v = PAD.v0 + 6;
      const [x, z] = toWorld(TOWN_FRAME, u, v);
      let room = 0;
      for (let j = 0; j < 16; j++) {
        const b = (j / 16) * Math.PI * 2;
        for (const r of [2, 4.5]) {
          const g = groundAt(x + Math.cos(b) * r, z + Math.sin(b) * r);
          if (g !== null && Math.abs(g - PAD_Y) < 0.2) room++;
        }
      }
      if (room < 26) continue; // most of both rings on the pad
      const [sx, sz] = toWorld(TOWN_FRAME, u, v - 1); // one metre seaward
      return { x, z, y: PAD_Y, face: { x: sx - x, z: sz - z } };
    }
    return null;
  }

  function begin(info: CeremonyInfo): boolean {
    clear();
    const at = spot();
    if (!at) return false;
    origin.set(at.x, at.y, at.z);
    yaw = Math.atan2(-at.face.z, at.face.x);

    // --- the display: podium, banner, fish rack (stays after the ceremony) ---
    const g = new THREE.Group();
    g.position.copy(origin);
    g.rotation.y = yaw;
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.85 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf3f1ea, roughness: 0.6 });
    const podium = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.4), white);
    podium.position.y = 0.3;
    g.add(podium);
    const one = textPlane([['bold 520px system-ui, sans-serif', '#f4c542', '1']], 1.0, 0.5);
    one.position.set(0.701, 0.3, 0); one.rotation.y = Math.PI / 2;
    g.add(one);

    // Rack behind the podium, running along local z: five fish by the tail, a tag under each.
    const rackX = -2.4, rackTop = 3.4, span = 5.4;
    g.add(beamBetween(V(rackX, 0, -span / 2), V(rackX, rackTop, -span / 2), 0.08, wood));
    g.add(beamBetween(V(rackX, 0, span / 2), V(rackX, rackTop, span / 2), 0.08, wood));
    g.add(beamBetween(V(rackX, rackTop, -span / 2 - 0.15), V(rackX, rackTop, span / 2 + 0.15), 0.07, wood));
    info.species.forEach((key, i) => {
      const S = SPECIES[key];
      const lb = info.weights[i] || S.min;
      const z = -span / 2 + span * ((i + 0.5) / info.species.length);
      const len = Math.min(rackTop - 0.6, scaledLenM(key, lb));
      const fish = makeFishMesh(S.color, len);
      fish.traverse((o) => {
        o.userData.keep = true; // shared creature geometry
        // Lit like a weigh station's display: the rack faces the water, so from the camera's side
        // the sun is usually behind it and the fish would read as black silhouettes. Their own
        // colour, faintly self-lit — cloned materials, never the shared ones, and no new light
        // (which would recompile every shader in the scene).
        if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
          o.material = o.material.clone();
          o.material.emissive.set(S.color).multiplyScalar(0.35);
          o.material.userData.ceremonyOwned = true;
        }
      });
      fish.rotation.set(-Math.PI / 2, 0, 0);
      fish.position.set(rackX + 0.15, rackTop - 0.25 - len / 2, z);
      g.add(fish);
      const tag = textPlane([['bold 120px system-ui, sans-serif', '#ffffff', S.name], ['bold 150px system-ui, sans-serif', '#f4c542', info.weights[i] ? `${lb.toFixed(1)} lb` : '']], 1.0, 0.42);
      tag.position.set(rackX + 0.12, 0.55, z); tag.rotation.y = Math.PI / 2;
      g.add(tag);
    });
    const banner = textPlane([
      ['bold 64px system-ui, sans-serif', '#ffffff', 'KEYS RUN FISHING TOURNAMENT'],
      ['bold 120px system-ui, sans-serif', '#f4c542', 'CHAMPION'],
      ['bold 84px system-ui, sans-serif', '#ffffff', info.name],
      ['56px system-ui, sans-serif', '#cfe6f2', info.boat],
    ], span, 2.0);
    banner.position.set(rackX - 0.05, rackTop + 1.15, 0); banner.rotation.y = Math.PI / 2;
    g.add(banner);
    g.add(beamBetween(V(rackX - 0.1, rackTop, -span / 2), V(rackX - 0.1, rackTop + 2.2, -span / 2), 0.05, wood));
    g.add(beamBetween(V(rackX - 0.1, rackTop, span / 2), V(rackX - 0.1, rackTop + 2.2, span / 2), 0.05, wood));
    deps.scene.add(g);
    deps.onBuilt(g);
    display = g;

    // --- the moment: winner, trophy, crowd, confetti (cleared when it ends) ---
    const p = new THREE.Group();
    const w = makeHuman({ walker: true, skin: info.captain ? 0xc68642 : 0xe0ac69, shirt: info.captain ? 0x1f2f46 : 0x2f8fd8, shortSleeve: true, shorts: 0xc9b38a, cap: info.captain ? 0xffffff : undefined, glasses: true });
    w.group.position.copy(local(0, 0.6, 0));
    w.group.rotation.y = yaw + Math.PI / 2; // humans face local +z; face the crowd (+x)
    trophy = makeTrophy();
    trophy.position.set(0, w.hipY + 1.08, 0.1);
    w.group.add(trophy);
    p.add(w.group);
    winner = w;

    let i = 0;
    for (const [radius, n] of [[3.2, 6], [4.4, 8]] as const) {
      for (let k = 0; k < n; k++) {
        const a = (Math.PI * 1.1) * (k / (n - 1) - 0.5);
        const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
        const wp = local(x, 0, z);
        const y = groundAt(wp.x, wp.z);
        if (y === null || Math.abs(y - origin.y) > 0.6) continue;
        const s = i * 7 + 3;
        const h = makeHuman({ walker: true, skin: pick(SKINS, s), shirt: pick(SHIRTS, s * 3 + 1), shortSleeve: true, shorts: 0x2b4a6e, cap: s % 3 === 0 ? pick(SHIRTS, s + 5) : undefined, glasses: s % 4 === 1 });
        h.group.position.set(wp.x, y, wp.z);
        h.group.rotation.y = Math.atan2(origin.x - wp.x, origin.z - wp.z);
        p.add(h.group);
        fans.push({ h, base: h.group.position.clone(), cheer: i % 2 === 0 });
        i++;
      }
    }

    const N = 260;
    const colors = [0xf2c14e, 0xffffff, 0x2f8fd8, 0xf26b5b, 0x3fb68b];
    confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.06, 0.1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), N);
    confetti.frustumCulled = false;
    for (let k = 0; k < N; k++) {
      confetti.setColorAt(k, new THREE.Color(colors[k % colors.length]));
      conf.push({ p: local((Math.random() - 0.3) * 6, 4 + Math.random() * 5, (Math.random() - 0.5) * 7), v: V((Math.random() - 0.5) * 0.6, -0.8 - Math.random() * 0.8, (Math.random() - 0.5) * 0.6), r: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0), spin: 2 + Math.random() * 6 });
    }
    p.add(confetti);
    deps.scene.add(p);
    deps.onBuilt(p);
    party = p;
    return true;
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);

  function update(dt: number, t: number): void {
    if (!party) return;
    if (winner) {
      const hy = winner.hipY;
      winner.update(t, 0);
      winner.poseLegs(FEET_L, FEET_R);
      // Trophy overhead in both hands, pumped on a beat.
      const pump = Math.abs(Math.sin(t * 3.2)) * 0.06;
      _hl.set(-0.13, hy + 1.0 + pump, 0.1); _hr.set(0.13, hy + 1.0 + pump, 0.1);
      winner.pose(_hl, _hr);
      if (trophy) trophy.position.y = hy + 1.08 + pump;
    }
    for (const f of fans) {
      const h = f.h, hy = h.hipY, ph = h.ph;
      h.update(t, 0);
      h.poseLegs(FEET_L, FEET_R);
      if (f.cheer) {
        const w = Math.sin(t * 7 + ph);
        _hl.set(-0.2 - w * 0.04, hy + 1.0, 0.05); _hr.set(0.2 + w * 0.04, hy + 1.0, 0.05);
        h.group.position.y = f.base.y + Math.abs(Math.sin(t * 5.5 + ph)) * 0.09;
      } else {
        const gap = 0.03 + Math.abs(Math.sin(t * 9 + ph)) * 0.12;
        _hl.set(-gap, hy + 0.42, 0.3); _hr.set(gap, hy + 0.42, 0.3);
      }
      h.pose(_hl, _hr);
      h.head.rotation.x = -0.15;
    }
    if (confetti) {
      for (let k = 0; k < conf.length; k++) {
        const c = conf[k];
        c.p.addScaledVector(c.v, dt);
        c.p.x += Math.sin(t * 2 + k) * dt * 0.3;
        c.r.x += c.spin * dt; c.r.y += c.spin * 0.7 * dt;
        if (c.p.y < origin.y) c.p.y += 8; // recycle from the top
        _m.compose(c.p, _q.setFromEuler(c.r), _one);
        confetti.setMatrixAt(k, _m);
      }
      confetti.instanceMatrix.needsUpdate = true;
    }
  }

  /** The ceremony's camera for `s` seconds in (0..10): a wide from the water side, close on the
   * trophy, then along the fish. Null when there's nothing built. */
  function shot(s: number): Shot | null {
    if (!display) return null;
    if (s < 3.5) {
      const u = s / 3.5;
      return { pos: local(11 - u * 2, 3.2 + u * 0.6, -5 + u * 6), look: local(-1, 2.2, 0) };
    }
    if (s < 7) {
      const u = (s - 3.5) / 3.5;
      const a = -0.5 + u * 1.0;
      return { pos: local(Math.cos(a) * 3.4, 2.6 - u * 0.5, Math.sin(a) * 3.4), look: local(0, 2.55, 0) };
    }
    // Along the rack at fish height from just behind the podium — close enough that it's one fish
    // after another, and the winner isn't standing in front of them.
    const u = Math.min(1, (s - 7) / 3);
    return { pos: local(-0.6, 2.5, -2.3 + u * 4.6), look: local(-2.4, 2.35, -2.0 + u * 4.0) };
  }

  /** The ten seconds are up: the crowd goes home, the display stays. */
  function end(): void {
    dispose(party);
    party = null; winner = null; trophy = null; fans = []; confetti = null; conf = [];
  }

  return { begin, update, shot, end, clear, get active() { return party !== null; }, spot };
}

export type Ceremony = ReturnType<typeof createCeremony>;
