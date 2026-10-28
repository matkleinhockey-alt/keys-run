/**
 * Numeric check for entities/crew-model/sea-legs.ts on the real rigged crew asset: puts one figure
 * on a synthetic deck (no game boot), rolls / heaves / surges that deck, and prints torso tilt,
 * knee position and foot height in world space. Expected vs. the 'level' baseline: rolled → torso
 * tilt well short of 'rolledRigid' (held toward world-upright); heavyHeave → knee further ahead,
 * hips lower, ankles at the same height (feet planted); surgeFwd → torso tipped further toward +z.
 * Needs the dev server (CLIENT_URL, default http://localhost:5174).
 */
import { chromium } from 'playwright';
import { CLIENT_URL } from './server.mjs';
const b = await chromium.launch(); const p = await b.newPage(); p.setDefaultTimeout(300000);
p.on('pageerror', (e) => console.log('pageerror', String(e)));
await p.goto(process.env.CLIENT_URL || CLIENT_URL, { waitUntil: 'load' });
await p.waitForTimeout(1500);
const out = await p.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js').catch(() => import('three'));
  const { loadCrewAsset } = await import('/src/entities/crew-model/asset.ts');
  const { createAnimatedFigure, updateFigure } = await import('/src/entities/crew-model/dance.ts');
  const { clone } = await import('/node_modules/.vite/deps/three_addons_utils_SkeletonUtils__js.js').catch(() => import('three/addons/utils/SkeletonUtils.js'));
  const asset = await loadCrewAsset();
  const H = 1.7;
  const beat = { bpm: () => 100, isPlaying: () => false };
  const motion = { speed: 0, steer: 0, air: false };
  const bone = (o, n) => { let h; o.traverse((x) => { if (!h && x.name.replace(/^mixamorig:?/, '') === n) h = x; }); return h; };
  const wp = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };

  function make() {
    const deck = new THREE.Group();
    const obj = clone(asset.template);
    obj.scale.setScalar(H / 1.8298);
    deck.add(obj);
    const mixer = new THREE.AnimationMixer(obj);
    const action = mixer.clipAction(asset.clip); action.play(); mixer.update(0);
    const f = createAnimatedFigure(obj, mixer, action, 0);
    return { deck, obj, f };
  }
  const measure = ({ obj }) => {
    const hips = wp(bone(obj, 'Hips')), head = wp(bone(obj, 'Head'));
    const lk = wp(bone(obj, 'LeftLeg')), lh = wp(bone(obj, 'LeftUpLeg')), la = wp(bone(obj, 'LeftFoot'));
    const t = head.clone().sub(hips);
    return {
      torsoTiltXdeg: THREE.MathUtils.radToDeg(Math.atan2(t.x, t.y)), // + = toward world +x
      torsoTiltZdeg: THREE.MathUtils.radToDeg(Math.atan2(t.z, t.y)),
      hipY: +hips.y.toFixed(3), ankleY: +la.y.toFixed(3),
      kneeAheadOfHipAnkleZ: +(lk.z - (lh.z + la.z) / 2).toFixed(3),
    };
  };
  const dt = 1 / 60;
  const res = {};
  // Baseline: still, level deck.
  { const s = make(); for (let i = 0; i < 300; i++) updateFigure(s.f, i * dt, dt, motion, beat); res.level = measure(s); }
  // Deck rolled 10° so the figure's +x side goes down: rotation about +z by −10°.
  { const s = make(); s.deck.rotation.z = -THREE.MathUtils.degToRad(10);
    for (let i = 0; i < 600; i++) updateFigure(s.f, i * dt, dt, motion, beat); res.rolled = measure(s); }
  // Same roll, physics bypassed: what the body would be if rigidly carried with the deck.
  { const s = make(); s.deck.rotation.z = -THREE.MathUtils.degToRad(10);
    s.f.mixer.update(0); s.obj.rotation.set(0, 0, 0); res.rolledRigid = measure(s); }
  // Deck accelerating upward at 0.5 g (cresting into a swell) — knees should load.
  { const s = make(); let v = 0, y = 0;
    for (let i = 0; i < 90; i++) { v += 4.9 * dt; y += v * dt; s.deck.position.y = y; updateFigure(s.f, i * dt, dt, motion, beat); }
    const m = measure(s); m.hipY -= y; m.ankleY -= y; res.heavyHeave = m; }
  // Deck accelerating forward (+z, the figure's forward) at 3 m/s².
  { const s = make(); let v = 0, z = 0;
    for (let i = 0; i < 300; i++) { v += 3 * dt; z += v * dt; s.deck.position.z = z; updateFigure(s.f, i * dt, dt, motion, beat); }
    const m = measure(s); res.surgeFwd = m; }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
