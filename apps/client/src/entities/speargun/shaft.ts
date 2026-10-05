/**
 * Visuals for the three things sim/spear.ts's pure integrator produces: the flying shaft
 * (`ShotState`, while `alive`), the retrieval tether running from the muzzle back to that shaft
 * the whole time it's away (a real speargun shaft stays tied to the gun by its own line — this
 * is what reads on screen as "the shaft didn't just vanish from the gun"), and, once a fish is
 * landed on the spear, the float-line running from it up to a small surface float — a common
 * real-spearfishing rig (a breakaway/float line keeps a hard-fighting fish from towing the diver
 * into the reef) and this port's visual distinguisher from rod fishing's bobber-on-a-rod-tip line.
 */
import * as THREE from 'three';
import { waveHBase } from '@keysrun/shared/waves';
import type { ShotState } from '@keysrun/shared/sim/spear';
import type { Vec3 } from '@keysrun/shared/sim/spear';
import { clamp, rand } from '../../core/math.js';

export interface ShaftVisual {
  group: THREE.Group;
  setVisible(v: boolean): void;
  update(shot: ShotState): void;
  dispose(): void;
}

const SHAFT_LEN = 0.6;

export function createShaftVisual(scene: THREE.Scene): ShaftVisual {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, SHAFT_LEN, 6).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.8, roughness: 0.3 }),
  );
  group.add(mesh);

  // The tether: muzzle -> shaft tail. A thin, slightly slack-looking line rather than the shaft
  // mesh's own rigid cylinder — real spear line has visible catenary sag even over 11 m.
  const tetherGeo = new THREE.BufferGeometry();
  const TSEG = 8;
  tetherGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TSEG + 1) * 3), 3));
  const tether = new THREE.Line(tetherGeo, new THREE.LineBasicMaterial({ color: 0xe9eef2, transparent: true, opacity: 0.55 }));
  tether.frustumCulled = false;
  group.add(tether);

  function setVisible(v: boolean): void { group.visible = v; }

  function update(shot: ShotState): void {
    // The shaft's *tail* trails `SHAFT_LEN` behind its leading point (`shot.dist`) rather than
    // centering on it, so the tip — not the midpoint — is what actually reaches `shot.dist`
    // (and so a hit at `atDist` looks like the point, not the middle of the shaft, struck home).
    const tipDist = shot.dist, tailDist = Math.max(0, shot.dist - SHAFT_LEN);
    const midDist = (tipDist + tailDist) / 2;
    mesh.position.set(shot.ox + shot.dx * midDist, shot.oy + shot.dy * midDist, shot.oz + shot.dz * midDist);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(shot.dx, shot.dy, shot.dz));

    const tailX = shot.ox + shot.dx * tailDist, tailY = shot.oy + shot.dy * tailDist, tailZ = shot.oz + shot.dz * tailDist;
    const arr = tetherGeo.attributes.position.array as Float32Array;
    for (let i = 0; i <= TSEG; i++) {
      const u = i / TSEG;
      // A little gravity sag at the midpoint, same sine-bow trick game/fishing/visuals.ts's cast
      // line uses — just enough to read as line, not a laser.
      const sag = Math.sin(u * Math.PI) * Math.min(0.12, tailDist * 0.03);
      arr[i * 3] = shot.ox + (tailX - shot.ox) * u;
      arr[i * 3 + 1] = shot.oy + (tailY - shot.oy) * u - sag;
      arr[i * 3 + 2] = shot.oz + (tailZ - shot.oz) * u;
    }
    tetherGeo.attributes.position.needsUpdate = true;
  }

  function dispose(): void { scene.remove(group); mesh.geometry.dispose(); tetherGeo.dispose(); }

  return { group, setVisible, update, dispose };
}

export interface FloatLineVisual {
  group: THREE.Group;
  setVisible(v: boolean): void;
  /** `fishPos` is the speared fish's current position (`SpearFightState.x/z` plus a cosmetic
   * depth); `t`/`sw`/`ch` feed the float's bob, same wave function the surface bobber/hull use
   * (`waveHBase` — no boat wake term here; see this module's header, a diver away from the boat
   * doesn't need that contribution). `tension` (0..1.2, `SpearFightState.tension`) makes the line
   * behave like a real line under load rather than a cosmetic tether: taut and closer to straight
   * near the danger zone, slack and sagging when eased off, with a visible high-frequency judder
   * right at the edge of tearing free — the same information the fight-meter's tension bar gives
   * numerically, read here as a physical line instead. */
  update(fishPos: Vec3, t: number, sw: number, ch: number, tension: number): void;
  dispose(): void;
}

const LSEG = 16;

export function createFloatLineVisual(scene: THREE.Scene): FloatLineVisual {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((LSEG + 1) * 3), 3));
  // Colour (not just geometry) carries tension too — see `update`'s lerp toward a hot amber-red as
  // tension climbs, matching the fight-meter bar's own `.hot` threshold (fight-ui.ts).
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
  const line = new THREE.Line(lineGeo, lineMat);
  line.frustumCulled = false;
  group.add(line);

  const float = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf2c14e }));
  top.position.y = 0.07;
  float.add(top);
  const bot = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  bot.position.y = -0.06;
  float.add(bot);
  group.add(float);

  const tautColor = new THREE.Color(0xff5a3c);
  const slackColor = new THREE.Color(0xffffff);
  const tmpColor = new THREE.Color();

  function setVisible(v: boolean): void { group.visible = v; }

  function update(fishPos: Vec3, t: number, sw: number, ch: number, tension: number): void {
    const surfaceY = waveHBase(fishPos.x, fishPos.z, t, 0.3, sw, ch);
    // A taut line pulls the float a little toward the fish rather than sitting dead overhead —
    // cheap but it's the one cue that reads as "this line is under load" even from a glance.
    const pull = clamp(tension, 0, 1.2) * 0.35;
    float.position.set(fishPos.x, surfaceY, fishPos.z);
    const tFrac = clamp((tension - 0.25) / 0.85, 0, 1);
    // Slack line sags in a gravity-bow scaled by the line's own vertical span; a taut line runs
    // almost straight. High tension (near the tornFree threshold, sim/spear.ts's 1.1) adds a fast
    // judder on top — the line visibly shuddering right before it would let go.
    const span = Math.abs(surfaceY - fishPos.y);
    const sag = (1 - tFrac) * clamp(span * 0.22, 0, 1.1);
    const judder = tension > 0.95 ? Math.sin(t * 46) * 0.03 * clamp((tension - 0.95) / 0.25, 0, 1) : 0;
    const arr = lineGeo.attributes.position.array as Float32Array;
    for (let i = 0; i <= LSEG; i++) {
      const u = i / LSEG;
      arr[i * 3] = fishPos.x + judder * Math.sin(u * 7 + t * 20);
      arr[i * 3 + 1] = fishPos.y + (surfaceY - fishPos.y) * u - Math.sin(u * Math.PI) * sag;
      arr[i * 3 + 2] = fishPos.z + judder * Math.cos(u * 7 + t * 20) - pull * u * (1 - u) * 2;
    }
    lineGeo.attributes.position.needsUpdate = true;
    tmpColor.copy(slackColor).lerp(tautColor, clamp(tension, 0, 1));
    lineMat.color.copy(tmpColor);
    lineMat.opacity = 0.7 + clamp(tension, 0, 1) * 0.3;
  }

  function dispose(): void {
    scene.remove(group);
    lineGeo.dispose();
  }

  return { group, setVisible, update, dispose };
}

export interface MuzzleBubbles {
  /** Fires a burst of bubbles from `pos`, drifting roughly along `dir` with the usual upward
   * buoyancy — a loaded band snapping forward through water visibly exhausts a slug of air out
   * the muzzle; this is that puff, not a generic "something happened" effect. */
  burst(pos: Vec3, dir: Vec3): void;
  update(dt: number): void;
  dispose(): void;
}

const BUBBLE_MAX = 120;

/** Self-contained — intentionally NOT reusing world/particles.ts's shared wake/spray system
 * (apps/client/src/world/particles.ts), which only this task's own files would need to be wired
 * into (threading a `ParticleSystem` instance through `SpeargunDeps`/world.ts for one small
 * muzzle puff is a lot of cross-module plumbing for an effect this cheap to own outright — see
 * this task's report for the explicit tradeoff). Rises and fades on its own; no wave/wake term
 * needed underwater, unlike that module's surface spray. */
export function createMuzzleBubbles(scene: THREE.Scene): MuzzleBubbles {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(BUBBLE_MAX * 3);
  const alpha = new Float32Array(BUBBLE_MAX);
  const size = new Float32Array(BUBBLE_MAX);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'attribute float alpha;attribute float psize;varying float vA;void main(){vA=alpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=psize*(380./-mv.z);gl_Position=projectionMatrix*mv;}',
    fragmentShader: 'varying float vA;void main(){vec2 c=gl_PointCoord-.5;float d=length(c);if(d>.5)discard;float rim=smoothstep(.5,.3,d)*0.9;gl_FragColor=vec4(0.85,0.95,1.0,vA*rim);}',
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  interface B { on: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number }
  const parts: B[] = [];
  for (let i = 0; i < BUBBLE_MAX; i++) parts.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
  let cursor = 0;

  function burst(muzzle: Vec3, dir: Vec3): void {
    const n = 14 + Math.floor(rand(0, 8));
    for (let i = 0; i < n; i++) {
      const p = parts[cursor];
      cursor = (cursor + 1) % BUBBLE_MAX;
      // A forward cone along the muzzle direction, not an omnidirectional pop — this is exhaust
      // from the shaft's own passage, not an explosion.
      const spread = 0.35;
      p.on = true;
      p.x = muzzle.x; p.y = muzzle.y; p.z = muzzle.z;
      p.vx = dir.x * rand(1.2, 2.6) + rand(-spread, spread);
      p.vy = dir.y * rand(1.2, 2.6) + rand(-spread, spread) + 0.6; // buoyancy bias
      p.vz = dir.z * rand(1.2, 2.6) + rand(-spread, spread);
      p.life = rand(0.35, 0.8);
      p.max = p.life;
    }
  }

  function update(dt: number): void {
    for (let i = 0; i < BUBBLE_MAX; i++) {
      const p = parts[i];
      if (!p.on) { alpha[i] = 0; continue; }
      p.life -= dt;
      if (p.life <= 0) { p.on = false; alpha[i] = 0; continue; }
      p.vx *= 1 - dt * 1.5; p.vz *= 1 - dt * 1.5;
      p.vy += dt * 0.8; // bubbles accelerate upward (buoyancy), unlike spray falling under gravity
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      alpha[i] = clamp(p.life / p.max, 0, 1) * 0.8;
      size[i] = 0.04 + (1 - p.life / p.max) * 0.05;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
    geo.attributes.psize.needsUpdate = true;
  }

  function dispose(): void { scene.remove(points); geo.dispose(); mat.dispose(); }

  return { burst, update, dispose };
}
