/**
 * A procedural fish body for the hooked-fish mesh, the grip-and-grin photo rig, and the catch
 * portrait (legacy `makeFishMesh`, index.html:2623-2626, was a simple body+tail blob — see below
 * for why this is now the real per-species geometry).
 *
 * ## Why this changed (fish-geometry task)
 *
 * This used to build a generic `SphereGeometry` body + 4-segment `ConeGeometry` tail, species-
 * colored only — entities/fish/** (the real lofted-body/fin system driven by @keysrun/shared's
 * SHAPE/VIS) "hadn't landed on `integration` yet when fishing/spearfishing were ported" (this
 * file's previous header). It has landed since, and the catch portrait's lighting/material pass
 * (game/catch/portrait.ts) made the generic blob's flatness obvious: a mahi read as "a smooth
 * capsule with a flat triangular cone stuck on the back" under real specular. This file now
 * builds the exact same per-species hull+fins entities/fish/geometry.ts's schools use
 * (`buildCreatureGeo`, `'high'` detail tier — see body.ts/fins.ts headers), just as one
 * standalone (non-instanced) mesh instead of an InstancedMesh pool entry.
 *
 * **The integration seam this header used to describe is now crossed** — every call site below
 * (visuals.ts's hooked fish, catch-flow.ts's photo rig, portrait.ts's studio shot) gets the real
 * shape. The one wrinkle: `createPortrait`'s `show(color, lenM)` (game/catch/portrait.ts, out of
 * this task's scope — see the task brief) only ever had a flat hex color to work with, never a
 * species key, because the old generic body didn't need one. Rather than touch that frozen file,
 * `keyForColor` below recovers the species key from that same color string: every @keysrun/shared
 * SPECIES entry's `color` is unique (checked against the full ~40-entry table), so the reverse
 * lookup is exact, not a guess. If a color somehow doesn't match any species (shouldn't happen —
 * every call site sources it from `SPECIES[key].color`), this falls back to the old generic blob
 * rather than throwing.
 *
 * Geometry is rebuilt fresh on every call rather than cached per species: `game/catch/portrait.ts`
 * (frozen, not this task's to edit) disposes the mesh's geometry on every `show()`/`clear()` —
 * sharing a cached geometry across catches would hand portrait.ts's disposal a geometry still in
 * use by a live hooked-fish/photo-rig mesh. A fresh build is one buildCreatureGeo call per catch
 * event (human-interaction frequency, not per-frame), the same cost class as legacy's per-catch
 * build here.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { VIS } from '@keysrun/shared/content/creatures';
import { buildCreatureGeo } from '../../entities/fish/geometry.js';
import { makeWetFishMaterial } from './fish-skin.js';

/** Keyed by `color|lengthBucket`: the scale shader's frequency is baked per material (it is a
 * uniform set in onBeforeCompile), so two very differently-sized fish of the same species colour
 * must not share one. Bucketed to the nearest 0.25 m so this stays a handful of materials rather
 * than one per catch. */
const matCache = new Map<string, THREE.MeshPhysicalMaterial>();
function matFor(color: string, lenM: number): THREE.MeshPhysicalMaterial {
  const bucket = Math.max(0.25, Math.round(lenM * 4) / 4);
  const ck = `${color}|${bucket}`;
  let m = matCache.get(ck);
  if (!m) { m = makeWetFishMaterial(color, { lengthM: bucket }); matCache.set(ck, m); }
  return m;
}

/** Lazily-built reverse lookup, `SPECIES[key].color -> key` — see this file's header. Built once
 * from plain data (no three.js), cached at module scope like `matCache`. */
let colorToKey: Map<string, string> | null = null;
function keyForColor(color: string): string | null {
  if (!colorToKey) {
    colorToKey = new Map();
    for (const k of Object.keys(SPECIES)) colorToKey.set(SPECIES[k].color, k);
  }
  return colorToKey.get(color) ?? null;
}

/** The pre-port generic body+tail blob — kept only as a fallback for a color that doesn't match
 * any known species (defensive; every real call site sources `color` from `SPECIES[key].color`,
 * so this should never actually run). */
function makeGenericFishMesh(color: string, lenM: number): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.3, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), m);
  body.scale.set(0.2, 0.32, 1);
  g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.6, 4), m);
  tail.rotation.x = -Math.PI / 2;
  tail.scale.set(0.25, 1, 1);
  tail.position.z = 1.15;
  g.add(tail);
  g.scale.setScalar(lenM / 2);
  return g;
}

/** legacy `makeFishMesh(color)`. `lenM` scales the group so `group`'s overall length (snout to
 * tail tip) is approximately `lenM` meters. Builds the real per-species hull+fins (see this
 * file's header) when `color` resolves to a known species; falls back to the old generic blob
 * otherwise. */
export function makeFishMesh(color: string, lenM = 1): THREE.Group {
  const key = keyForColor(color);
  const V = key ? VIS[key] : undefined;
  if (!key || !V) return makeGenericFishMesh(color, lenM);

  const g = new THREE.Group();
  const geo = buildCreatureGeo(key, V, 'high');
  const mesh = new THREE.Mesh(geo, matFor(color, lenM));
  g.add(mesh);
  // buildCreatureGeo bakes the species' real proportions at V.len meters nose-to-peduncle
  // (nose at local z=-V.len/2, same convention the old generic body used) — rescale to the
  // caller's target length instead of legacy's fixed "unscaled body runs ~2m" assumption.
  g.scale.setScalar(lenM / V.len);
  return g;
}
