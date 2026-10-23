/**
 * Keys Run Estates in the world: every owned lot (bought or founding) with what its owner built
 * on it, the procedural cottages cleared off it, and the #1 angler's party at theirs.
 *
 * Data comes from the estate registry (game/estates/registry.ts) and positions from
 * `siteLayout` (packages/shared/src/content/estates.ts) — never computed here — so the house you
 * see, the dock you tie up to and the ground you walk on are one answer, not three.
 *
 * ## What is drawn when
 * There can be ~280 estates. Each is two things:
 *   - a far silhouette: one instance in a single InstancedMesh shared by all estates (a pale box
 *     the size of the house), shown beyond DETAIL_OUT so a built-up shore still reads as built up
 *     from across the bay;
 *   - the detail: house, dock, mounts, trophies, signs — built only when the camera comes within
 *     DETAIL_IN and freed again past DETAIL_OUT (the gap is hysteresis, so idling at the edge
 *     doesn't rebuild every frame). At most BUILDS_PER_FRAME are built in one frame.
 * The party, when there is one, is part of its lot's detail.
 *
 * ## Rebuilds
 * Each estate is keyed by `parcelId + build JSON + party`. A registry change rebuilds only the
 * estates whose key changed (a new purchase, a saved build, the party moving house), and re-runs
 * the scenery clearing once for the whole set.
 *
 * Disposal frees geometry only. Materials are shared (./materials.ts), except signs' and the
 * party bulbs', which say so in userData; rafted boats are marked `keep` because `makeBoat`'s
 * parts may share geometry with the player's own hull.
 */
import * as THREE from 'three';
import {
  estateGround, parcelById, pointInPoly, siteLayout,
  type Estate, type Parcel, type SiteLayout,
} from '@keysrun/shared/content/estates';
import { landH } from '@keysrun/shared/world/depth';
import { PAD_Y, groundAt } from '@keysrun/shared/world/town';
import type { EstateRegistry } from '../../game/estates/registry.js';
import type { ClearScenery } from '../../world/islands.js';
import { buildResidence } from './residences.js';
import { buildDock, buildFirepit, buildMount, buildOwnerBoard, buildPool, buildTrophies, doorMount, type EstateSite } from './grounds.js';
import { buildParty, type BoatFx, type EstateParty } from './party.js';
import { mats } from './materials.js';

export type { BoatFx };

const DETAIL_IN = 1500;
const DETAIL_OUT = 1800;
const BUILDS_PER_FRAME = 2;

export interface EstatesViewDeps {
  scene: THREE.Scene;
  registry: EstateRegistry;
  /** Called with each detail group as it is built (world.ts: cascaded shadows). */
  onBuilt?(o: THREE.Object3D): void;
  /** world/islands.ts's `clearScenery`: hides cottages on owned lots, trees under their houses. */
  clearScenery?: ClearScenery;
  /** For the party boats' own deck parties; optional. */
  boatFx?: BoatFx;
}

interface Entry {
  key: string;
  site: EstateSite;
  partyOn: boolean;
  detail: THREE.Group | null;
  party: EstateParty | null;
  flame: THREE.Mesh | null;
}

function shorePoint(p: Parcel, L: SiteLayout): [number, number] {
  let best = -Infinity, out: [number, number] = [p.cx, p.cz];
  for (const [x, z] of p.poly) { const d = (x - p.cx) * L.sea[0] + (z - p.cz) * L.sea[1]; if (d > best) { best = d; out = [x, z]; } }
  return out;
}

function makeSite(p: Parcel, e: Estate): EstateSite {
  const layout = siteLayout(p, e.build);
  const harbor = p.tier === 'harbor';
  return {
    parcel: p, estate: e, layout, shore: shorePoint(p, layout),
    groundY: (x, z) => harbor ? (groundAt(x, z) ?? PAD_Y) : (estateGround(p, layout, x, z) ?? Math.max(0.3, landH(x, z))),
  };
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o.userData.keep) return;
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      if (o.userData.ownMat) {
        const m = o.material as THREE.MeshBasicMaterial;
        m.map?.dispose();
        m.dispose();
      }
    }
  });
}

export function createEstatesView(deps: EstatesViewDeps) {
  const root = new THREE.Group();
  root.name = 'estates';
  deps.scene.add(root);
  const entries = new Map<string, Entry>();

  // One instanced silhouette for every estate, rebuilt with the set.
  let far: THREE.InstancedMesh | null = null;
  const farGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  /** Whether each entry's silhouette instance is currently shown (vs. zeroed under its detail). */
  const farShown = new Map<Entry, boolean>();

  function keyOf(e: Estate, partyOn: boolean): string {
    return `${e.parcelId}|${e.ownerName}|${JSON.stringify(e.build)}|${partyOn ? 'party' : ''}`;
  }

  function freeDetail(en: Entry): void {
    if (en.detail) { root.remove(en.detail); disposeTree(en.detail); en.detail = null; }
    en.party?.dispose();
    en.party = null;
    en.flame = null;
  }

  function buildDetail(en: Entry): void {
    const { site } = en;
    const { layout: L, estate: e } = site;
    const b = e.build;
    const g = new THREE.Group();
    g.name = `estate-${site.parcel.id}`;

    const res = buildResidence(b.res, L.house.w, L.house.d);
    const house = res.group;
    house.position.set(L.house.x, L.house.y, L.house.z);
    // Harbor Row's "seaward" side is the back lane where the town's cars park, 3 m off the house:
    // turn the house round so its terrace and pool open onto the lot instead of onto the cars.
    house.rotation.y = L.heading + (site.parcel.tier === 'harbor' ? Math.PI : 0);
    if (b.mount === 'door') house.add(doorMount(b, res.doorTop, res.frontZ));
    g.add(house);

    const dock = buildDock(site, b);
    if (dock) g.add(dock);
    const mount = buildMount(site, b);
    if (mount) g.add(mount);
    g.add(buildTrophies(site));
    // villa and glass carry a pool deck of their own; the others get the layout's pool
    if (b.res !== 'villa' && b.res !== 'glass') { const pool = buildPool(site); if (pool) g.add(pool); }
    const fire = buildFirepit(site);
    if (fire) { g.add(fire.group); en.flame = fire.flame; }
    g.add(buildOwnerBoard(site));

    if (en.partyOn && deps.registry.registry.party) {
      en.party = buildParty(site, deps.registry.registry.party, deps.boatFx);
      g.add(en.party.group);
    }
    root.add(g);
    en.detail = g;
    deps.onBuilt?.(g);
  }

  function rebuildFar(): void {
    if (far) { root.remove(far); far.dispose(); }
    const list = [...entries.values()];
    far = new THREE.InstancedMesh(farGeo, mats().silhouette, Math.max(1, list.length));
    far.count = list.length;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    list.forEach((en, i) => {
      const L = en.site.layout;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), L.heading);
      s.set(L.house.w, en.site.estate.build.res === 'shack' ? 3 : 7, L.house.d);
      p.set(L.house.x, L.house.y, L.house.z);
      far!.setMatrixAt(i, m.compose(p, q, s));
    });
    far.instanceMatrix.needsUpdate = true;
    far.computeBoundingSphere();
    root.add(far);
    farShown.clear();
  }

  /** Which instance of `far` is which entry, in insertion order — so update() can hide the
   * silhouette of an estate whose detail is showing. */
  let farOrder: Entry[] = [];

  function clearScenery(): void {
    if (!deps.clearScenery) return;
    const sites = [...entries.values()].map((e) => e.site);
    const clears = sites.map((s) => {
      const L = s.layout;
      const r = Math.max(L.house.w, L.house.d) * (s.estate.build.res === 'garden' ? 1.4 : 0.8) + 3;
      const spots = [L.mount, ...(L.pool ? [L.pool] : []), ...(L.firepit ? [L.firepit] : []), ...L.trophies];
      return { s, r, spots };
    });
    deps.clearScenery(
      (x, z) => sites.some((s) => pointInPoly(s.parcel.poly, x, z)),
      (x, z) => clears.some(({ s, r, spots }) => {
        const L = s.layout;
        if (Math.hypot(x - L.house.x, z - L.house.z) < r) return true;
        if (spots.some((p) => Math.hypot(x - p.x, z - p.z) < 3.5)) return true;
        const d = L.dock;
        if (d) {
          // the dock's line, plus the party's rafted boats beside it
          const along = (x - d.x0) * L.sea[0] + (z - d.z0) * L.sea[1];
          const across = Math.abs((x - d.x0) * -L.sea[1] + (z - d.z0) * L.sea[0]);
          if (along > -6 && along < d.len + 4 && across < d.w / 2 + 9) return true;
        }
        return false;
      }),
    );
  }

  function sync(): void {
    const reg = deps.registry.registry;
    const partyId = reg.party?.parcelId ?? null;
    const seen = new Set<string>();
    let changed = false;
    for (const e of reg.estates) {
      const p = parcelById(e.parcelId);
      if (!p) continue;
      seen.add(e.parcelId);
      const partyOn = e.parcelId === partyId;
      const key = keyOf(e, partyOn);
      const old = entries.get(e.parcelId);
      if (old && old.key === key) continue;
      if (old) freeDetail(old);
      entries.set(e.parcelId, { key, site: makeSite(p, e), partyOn, detail: null, party: null, flame: null });
      changed = true;
    }
    for (const [id, en] of entries) if (!seen.has(id)) { freeDetail(en); entries.delete(id); changed = true; }
    if (!changed) return;
    farOrder = [...entries.values()];
    rebuildFar();
    clearScenery();
  }

  const unsubscribe = deps.registry.subscribe(sync);
  sync();

  const _m = new THREE.Matrix4(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

  function update(dt: number, t: number, cam: THREE.Vector3): void {
    let builds = 0;
    let farDirty = false;
    farOrder.forEach((en, i) => {
      const L = en.site.layout;
      const d = Math.hypot(L.house.x - cam.x, L.house.z - cam.z);
      if (!en.detail && d < DETAIL_IN && builds < BUILDS_PER_FRAME) { buildDetail(en); builds++; }
      else if (en.detail && d > DETAIL_OUT) freeDetail(en);
      const showFar = !en.detail;
      if (far && farShown.get(en) !== showFar) {
        if (showFar) {
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), L.heading);
          far.setMatrixAt(i, _m.compose(new THREE.Vector3(L.house.x, L.house.y, L.house.z), q, new THREE.Vector3(L.house.w, en.site.estate.build.res === 'shack' ? 3 : 7, L.house.d)));
        } else far.setMatrixAt(i, ZERO);
        farShown.set(en, showFar);
        farDirty = true;
      }
      if (en.flame) { en.flame.scale.set(1, 0.8 + Math.sin(t * 13 + i) * 0.15 + Math.sin(t * 7.3) * 0.1, 1); en.flame.rotation.y = t * 2; }
      en.party?.update(dt, t, cam);
    });
    if (farDirty && far) far.instanceMatrix.needsUpdate = true;
  }

  function dispose(): void {
    unsubscribe();
    for (const en of entries.values()) freeDetail(en);
    entries.clear();
    if (far) { root.remove(far); far.dispose(); }
    farGeo.dispose();
    deps.scene.remove(root);
    deps.clearScenery?.(() => false, () => false);
  }

  const debug = {
    list: () => [...entries.values()].map((en) => ({ id: en.site.parcel.id, owner: en.site.estate.ownerName, res: en.site.estate.build.res, dock: en.site.estate.build.dock, detail: !!en.detail, party: !!en.party, house: { x: +en.site.layout.house.x.toFixed(1), z: +en.site.layout.house.z.toFixed(1) } })),
    layout: (id: string) => entries.get(id)?.site.layout ?? null,
  };
  (window as unknown as { __estatesViewDebug?: typeof debug }).__estatesViewDebug = debug;

  return { update, dispose, root, sync };
}

export type EstatesView = ReturnType<typeof createEstatesView>;
