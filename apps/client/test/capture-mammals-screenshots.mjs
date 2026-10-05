/**
 * Marine mammal verification screenshots (task brief): a dolphin pod porpoising near the boat, a
 * pod bow-riding a moving boat, a whale surfacing with its blow, and a pod seen from underwater.
 * Saved to test/screenshots/mammals/.
 *
 * Same dev-only hooks as capture-fish-screenshots.mjs (window.__fishDebug.findResidentNear /
 * waterColumnAt / teleport, window.__fishDebugCamera) plus two additions used only by this script:
 *  - `window.__fishDebug.boatState()` (game/world.ts) — the boat's live x/z/heading/speed, needed
 *    for the bow-riding shot since that behavior only engages for a genuinely *moving* boat
 *    (teleport() always zeroes speed) and the camera needs to track where the boat actually ended
 *    up, not a guessed position.
 *  - `window.__fishDebug.activeSchools()` (already existed) to read a school's live centroid for
 *    framing, since a resident pod orbits its anchor rather than sitting still on it.
 *
 * This sandbox renders on a software/virtualised GPU — generous waits, no fps claims.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5195';
const OUT = path.join(HERE, 'screenshots', 'mammals');
fs.mkdirSync(OUT, { recursive: true });

async function findSpecies(page, type, originX, originZ, radius) {
  return page.evaluate(({ type, originX, originZ, radius }) => window.__fishDebug.findResidentNear(type, originX, originZ, radius), { type, originX, originZ, radius });
}

async function waterColumnAt(page, x, z) {
  return page.evaluate(({ x, z }) => window.__fishDebug.waterColumnAt(x, z, performance.now() / 1000), { x, z });
}

async function boatState(page) {
  return page.evaluate(() => window.__fishDebug.boatState());
}

async function activeSchoolNear(page, type, x, z) {
  return page.evaluate(({ type, x, z }) => {
    const schools = window.__fishDebug.activeSchools().filter((s) => s.type === type);
    if (!schools.length) return null;
    let best = schools[0], bestD = Infinity;
    for (const s of schools) {
      const d = Math.hypot(s.cx - x, s.cz - z);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }, { type, x, z });
}

function setCamera(page, eye, look) {
  return page.evaluate(({ eye, look }) => {
    window.__fishDebugCamera = { x: eye.x, y: eye.y, z: eye.z, lookX: look.x, lookY: look.y, lookZ: look.z };
  }, { eye, look });
}

/** Generic "park the boat out of frame, stand a camera off to one side of the target" shot —
 * same convention as capture-fish-screenshots.mjs's lookAt (boat and camera both on the
 * open-water side of the target, away from `origin`'s shoreline-adjacent direction). */
const BOAT_OFFSET = 60;
async function lookAtStatic(page, targetX, targetZ, standoff, levelT, origin, eyeLevelT = levelT) {
  const dx = origin.x - targetX, dz = origin.z - targetZ;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;

  await page.evaluate(({ bx, bz }) => window.__fishDebug.teleport(bx, bz), {
    bx: targetX + ux * BOAT_OFFSET, bz: targetZ + uz * BOAT_OFFSET,
  });
  await page.waitForTimeout(1200);

  const tgtCol = await waterColumnAt(page, targetX, targetZ);
  const lookY = tgtCol.floor + (tgtCol.surf - tgtCol.floor) * levelT;
  const eyeY = tgtCol.floor + (tgtCol.surf - tgtCol.floor) * eyeLevelT;
  const cx = targetX + ux * standoff, cz = targetZ + uz * standoff;
  await setCamera(page, { x: cx, y: eyeY, z: cz }, { x: targetX, y: lookY, z: targetZ });
  await page.waitForTimeout(600);
  return { cx, cz, eyeY };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.click('#btnGo');
await page.waitForTimeout(1000);

const REEF_ORIGIN = { x: 0, z: 1550 }; // reef wall — see capture-fish-screenshots.mjs
const HUMPS_ORIGIN = { x: -500, z: 3350 }; // Marathon Hump — creatures.ts ZONE_LIFE.Humps

// 1. Dolphin pod porpoising near the boat.
let dolphinPod = null;
{
  const hit = await findSpecies(page, 'dolphin', REEF_ORIGIN.x, REEF_ORIGIN.z, 1500);
  if (hit) {
    dolphinPod = hit;
    await lookAtStatic(page, hit.x, hit.z, 10, 0.78, REEF_ORIGIN, 0.5);
    // Pod members' first act fires within spawn.ts's 1-8s initial actTimer window; wait through
    // that plus a little of ACT_CD.porpoise's own [1.5,4]s cooldown so more than one member has a
    // chance to be mid-arc. Several frames spaced apart, since sim-time advances slowly here
    // (software WebGL) and any single fixed wait risks catching every member mid-trough.
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(2200);
      await page.screenshot({ path: path.join(OUT, `01-dolphin-porpoising-t${i}.png`) });
    }
    console.log('dolphin pod (porpoising) at', hit);
  } else {
    console.log('dolphin porpoising: no resident found within search radius');
  }
}

// 2. Dolphin pod bow-riding a moving boat. Needs a genuinely moving boat (teleport() always
// zeroes speed), so: place the boat BOAT_RUNUP_M behind the pod pointed straight at it (heading 0
// — teleport's h defaults to the boat's current heading, so pass 0 explicitly), hold throttle
// forward, and poll the boat's live state (not a guess) until it's both moving fast enough and
// close enough for behavior.ts's BOW_RIDE_RADIUS/BOW_RIDE_MIN_SPEED gate to have plausibly
// engaged (school.ts lerps g.bowRide in over ~1/0.6 s once that gate is met).
{
  const origin = dolphinPod ? { x: dolphinPod.x, z: dolphinPod.z + 400 } : REEF_ORIGIN;
  const hit = dolphinPod ?? await findSpecies(page, 'dolphin', REEF_ORIGIN.x, REEF_ORIGIN.z, 1500);
  if (hit) {
    const BOAT_RUNUP_M = 85;
    const boatStart = { x: hit.x, z: hit.z + BOAT_RUNUP_M }; // heading 0 (facing -z) points straight at the pod
    await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), boatStart);
    await page.waitForTimeout(1200);

    // Bang-bang throttle to hold speed inside behavior.ts's [BOW_RIDE_MIN_SPEED, BOW_RIDE_MAX_SPEED]
    // (1.8-14 m/s β‰ˆ 3.5-27 kn) window — holding KeyW continuously overshoots straight through it to
    // the hull's ~27 m/s top speed in a handful of seconds (confirmed: a first pass at this script
    // reached 43 kn and the pod never caught up, having dropped out of bow-ride range/speed).
    let engaged = false;
    let throttleDown = false;
    for (let i = 0; i < 24 && !engaged; i++) {
      await page.waitForTimeout(2000);
      const bs = await boatState(page);
      if (bs.speed > 8 && throttleDown) { await page.keyboard.up('KeyW'); throttleDown = false; }
      else if (bs.speed < 5 && !throttleDown) { await page.keyboard.down('KeyW'); throttleDown = true; }
      const school = await activeSchoolNear(page, 'dolphin', hit.x, hit.z);
      if (!school) continue;
      const dist = Math.hypot(bs.x - school.cx, bs.z - school.cz);
      console.log(`  bow-ride poll ${i}: boat speed=${bs.speed.toFixed(2)} dist-to-pod=${dist.toFixed(1)}`);
      if (bs.speed > 2.2 && bs.speed < 12 && dist < 55) engaged = true;
    }
    if (throttleDown) { await page.keyboard.up('KeyW'); throttleDown = false; }
    // Tap the throttle a couple more times to hold cruising speed (it decays once released) while
    // bow-riding settles in — g.bowRide (school.ts) lerps in at dt*0.6, ~1.7s time constant.
    for (let i = 0; i < 2; i++) {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(400);
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(1300);
    }

    const bs = await boatState(page);
    const school = await activeSchoolNear(page, 'dolphin', hit.x, hit.z);
    const fx = -Math.sin(bs.h), fz = -Math.cos(bs.h);
    const rx = Math.cos(bs.h), rz = -Math.sin(bs.h);
    const eyeTarget = school ?? { cx: hit.x, cz: hit.z };
    const eyeCol = await waterColumnAt(page, bs.x - rx * 9 + fx * -6, bs.z - rz * 9 + fz * -6);
    const eye = { x: bs.x - fx * 6 + rx * 10, y: eyeCol.surf + 2.6, z: bs.z - fz * 6 + rz * 10 };
    const lookCol = await waterColumnAt(page, eyeTarget.cx, eyeTarget.cz);
    const look = { x: (eyeTarget.cx + bs.x + fx * 6) / 2, y: lookCol.surf - 0.2, z: (eyeTarget.cz + bs.z + fz * 6) / 2 };
    await setCamera(page, eye, look);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, '02-dolphin-bowride.png') });
    await page.keyboard.up('KeyW');
    console.log('bow-ride shot: boat', bs, 'pod', school);
  } else {
    console.log('bow-riding: no dolphin resident found to approach');
  }
}

// 3. A whale surfacing with its blow — humpback (the ~15 m species) to show scale against the
// boat; falls back to pilotwhale (more copies on this seed, see creatures.ts's tuned weights) if
// no humpback resident turns up nearby. Boat is kept *in frame*, not pushed out of it, since the
// point of this shot is "does the whale dwarf the boat".
{
  let hit = await findSpecies(page, 'humpback', HUMPS_ORIGIN.x, HUMPS_ORIGIN.z, 2000);
  let type = 'humpback';
  if (!hit) { hit = await findSpecies(page, 'pilotwhale', HUMPS_ORIGIN.x, HUMPS_ORIGIN.z, 2000); type = 'pilotwhale'; }
  if (hit) {
    const dx = HUMPS_ORIGIN.x - hit.x, dz = HUMPS_ORIGIN.z - hit.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const px = -uz, pz = ux; // perpendicular, for a 3/4 camera offset
    const boatPt = { x: hit.x + ux * 32, z: hit.z + uz * 32 };
    // Offset the camera to one side (not dead astern of the boat) — lined up exactly behind the
    // boat hides the whale's blow plume behind the tower/superstructure (confirmed against an
    // actual capture: the blow fired per debugBlowCount but was invisible, occluded dead-on).
    const camPt = { x: hit.x + ux * 48 + px * 26, z: hit.z + uz * 48 + pz * 26 };
    const boatH = Math.atan2(-(hit.x - boatPt.x), -(hit.z - boatPt.z));
    await page.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h), { ...boatPt, h: boatH });
    await page.waitForTimeout(1200);

    const col = await waterColumnAt(page, hit.x, hit.z);
    const eyeCol = await waterColumnAt(page, camPt.x, camPt.z);
    await setCamera(page, { x: camPt.x, y: eyeCol.surf + 4, z: camPt.z }, { x: hit.x, y: col.surf - 1, z: hit.z });
    await page.waitForTimeout(800);
    // First act fires within spawn.ts's 1-8s window; ACT_DUR.blow=4.5s with the blow moment
    // roughly a third of the way through that cycle. Sim-time only advances up to 50ms per
    // *rendered* frame (docs note: software WebGL renders slowly), so poll the real blow counter
    // (index.ts's debugBlowCount, via __fishDebug) instead of guessing a wall-clock wait is long
    // enough, and keep shooting for a few seconds after it actually fires.
    const blowCountBefore = await page.evaluate(() => window.__fishDebug.blowCount());
    let blown = false;
    for (let i = 0; i < 20 && !blown; i++) {
      await page.waitForTimeout(2000);
      const n = await page.evaluate(() => window.__fishDebug.blowCount());
      await page.screenshot({ path: path.join(OUT, `03-whale-blow-${type}-t${i}.png`) });
      if (n > blowCountBefore) { blown = true; console.log(`  blow fired at poll ${i} (count ${blowCountBefore} -> ${n})`); }
    }
    if (blown) {
      // Catch a couple more frames right after — the fluke-up moment comes later in the same cycle.
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, `03-whale-blow-${type}-after1.png`) });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, `03-whale-blow-${type}-after2.png`) });
    } else {
      console.log('  blow never fired within the poll window — see the t*.png frames for the whale body/scale shot regardless');
    }
    console.log(`whale (${type}) surfacing at`, hit, 'boat at', boatPt);
  } else {
    console.log('whale blow: no humpback/pilotwhale resident found near the Humps');
  }
}

// 4. A dolphin pod seen from underwater — same pod as shot 1 if it's in reasonable depth,
// otherwise re-searched. Two-step camera placement (just above, then below, the surface) so the
// underwater transition tween (world/underwater/index.ts — gated purely on camera.position.y, so
// this debug camera genuinely drives it) has a real crossing to animate instead of snapping
// straight to depth on the very first frame.
{
  const hit = dolphinPod ?? await findSpecies(page, 'dolphin', REEF_ORIGIN.x, REEF_ORIGIN.z, 1500);
  if (hit) {
    const col = await waterColumnAt(page, hit.x, hit.z);
    const depth = col.surf - col.floor;
    const diveY = depth > 6 ? col.surf - 4 : col.surf - Math.max(1.2, depth * 0.55);
    const dx = REEF_ORIGIN.x - hit.x, dz = REEF_ORIGIN.z - hit.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const boatPt = { x: hit.x + ux * BOAT_OFFSET, z: hit.z + uz * BOAT_OFFSET };
    await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z), boatPt);
    await page.waitForTimeout(1000);

    const eyeXZ = { x: hit.x + ux * 6, z: hit.z + uz * 6 };
    await setCamera(page, { x: eyeXZ.x, y: col.surf + 1.2, z: eyeXZ.z }, { x: hit.x, y: col.surf - 0.3, z: hit.z });
    await page.waitForTimeout(600);
    await setCamera(page, { x: eyeXZ.x, y: diveY, z: eyeXZ.z }, { x: hit.x, y: col.surf - 0.4, z: hit.z });
    await page.waitForTimeout(1800); // let the underwater fog/FOV/lens tween settle
    await page.screenshot({ path: path.join(OUT, '04-dolphin-pod-underwater.png') });
    console.log('underwater pod shot at', hit, 'depth', depth.toFixed(1), 'eyeY', diveY.toFixed(1));
  } else {
    console.log('underwater pod: no dolphin resident found');
  }
}

console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
