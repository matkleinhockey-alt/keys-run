/**
 * Cosmetics on the figures: dressing changes colours not draw calls, stock figures pay nothing, and the
 * per-frame sync only rebuilds when the worn outfit changes. Node environment: no DOM is touched
 * (the flag slot is left empty, because painting a flag needs a canvas).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buy, emptyInventory } from '@keysrun/shared/sim/shop';
import { makeHuman } from '../src/entities/life/human.js';
import { createOutfitSync, dressFor, wardrobe } from '../src/entities/life/outfit.js';

const base = { walker: true, shirt: 0xf26b5b, shortSleeve: true, cap: 0xffffff, glasses: true } as const;
const meshes = (g: THREE.Object3D): number => { let n = 0; g.traverse((o) => { if (o instanceof THREE.Mesh) n++; }); return n; };
const colours = (m: THREE.Mesh): number[] => Array.from((m.geometry as THREE.BufferGeometry).attributes.color.array as Float32Array);
const verts = (m: THREE.Mesh): number => (m.geometry as THREE.BufferGeometry).attributes.position.count;

describe('Human.dress', () => {
  it('changes the shirt colours but not the number of meshes (so no extra draw calls)', () => {
    const h = makeHuman({ ...base });
    const before = meshes(h.group), stock = colours(h._dressParts.body);
    h.dress({ shirt: 0x2e9b3f });
    expect(meshes(h.group)).toBe(before);
    expect(colours(h._dressParts.body)).not.toEqual(stock);
  });
  it('dress({}) restores the everyday look exactly', () => {
    const h = makeHuman({ ...base });
    const body = colours(h._dressParts.body), head = colours(h._dressParts.headMesh);
    h.dress({ shirt: 0x2e9b3f, cap: 0xc9b37a, capStyle: 'bucket', glassesStyle: 'aviator', glassesColor: 0x3a3320 });
    h.dress({});
    expect(colours(h._dressParts.body)).toEqual(body);
    expect(colours(h._dressParts.headMesh)).toEqual(head);
  });
  it('a patterned shirt gets the extra torso vertices it needs; a plain one keeps the stock geometry', () => {
    const plain = makeHuman({ ...base });
    const v0 = verts(plain._dressParts.body);
    plain.dress({ shirt: 0x2e9b3f });
    expect(verts(plain._dressParts.body)).toBe(v0);
    plain.dress({ shirt: 0xf0a01c, shirtAccent: 0xd7263d, shirtPattern: 'hawaiian' });
    expect(verts(plain._dressParts.body)).toBeGreaterThan(v0);
  });
  it('a bucket hat and each glasses style reshape the head without adding meshes', () => {
    const h = makeHuman({ ...base });
    const n = meshes(h.group), pos = (): number[] => Array.from(h._dressParts.headMesh.geometry.attributes.position.array as Float32Array);
    const stock = pos();
    h.dress({ capStyle: 'bucket' });
    expect(pos()).not.toEqual(stock);
    for (const glassesStyle of ['wide', 'round', 'aviator'] as const) h.dress({ glassesStyle });
    expect(meshes(h.group)).toBe(n);
  });
  it('recolours the sleeves the arms are drawn with', () => {
    const h = makeHuman({ ...base, shortSleeve: false });
    h.dress({ shirt: 0x2e9b3f });
    const mat = (h._dressParts.sleeveMeshes[0].material as THREE.MeshStandardMaterial).color.getHex();
    expect(mat).toBe(0x2e9b3f);
    expect((h._dressParts.lowerArms[0].material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x2e9b3f);
  });
  it('leaves bikini figures alone', () => {
    const h = makeHuman({ bikini: true, shorts: 0xe4572e });
    const c = colours(h._dressParts.body);
    h.dress({ shirt: 0x2e9b3f });
    expect(colours(h._dressParts.body)).toEqual(c);
  });
});

describe('dressFor', () => {
  it('merges one look per slot and never lets a slot clobber another', () => {
    const d = dressFor({ shirt: 'cosmetic.shirt.breton', cap: 'cosmetic.cap.bucket', glasses: 'cosmetic.glasses.neon' });
    expect(d).toMatchObject({ shirtPattern: 'stripe', cap: 0xc9b37a, capStyle: 'bucket', glassesStyle: 'wide', glassesColor: 0xff3ea5, glasses: true });
  });
  it('is empty for an empty outfit, so an unworn figure is not touched', () => {
    expect(dressFor({})).toEqual({});
  });
});

describe('createOutfitSync', () => {
  beforeEach(() => wardrobe.set(emptyInventory()));
  const rig = () => {
    const body = makeHuman({ ...base });
    const captain = makeHuman({ ...base });
    const model = { captain, group: new THREE.Group(), setCosmeticFlag: vi.fn() };
    const onBuilt = vi.fn();
    const bodyDress = vi.spyOn(body, 'dress'), capDress = vi.spyOn(captain, 'dress');
    return { body, captain, model, onBuilt, bodyDress, capDress, sync: createOutfitSync({ body: () => body, model: () => model, onBuilt }) };
  };
  it('does no work at all with nothing worn, however many frames pass', () => {
    const r = rig();
    for (let i = 0; i < 200; i++) r.sync.update();
    expect(r.bodyDress).not.toHaveBeenCalled();
    expect(r.capDress).not.toHaveBeenCalled();
    expect(r.model.setCosmeticFlag).not.toHaveBeenCalled();
    expect(r.onBuilt).not.toHaveBeenCalled();
  });
  it('rebuilds once per change, not once per frame', () => {
    const r = rig();
    wardrobe.set(buy(emptyInventory(), 'gifts', 'shirt-hawaiian', 1e6, 0).inventory);
    for (let i = 0; i < 50; i++) r.sync.update();
    expect(r.bodyDress).toHaveBeenCalledTimes(1);
    expect(r.capDress).toHaveBeenCalledTimes(1);
    wardrobe.wear('cosmetic.shirt.hawaiian'); // already on: nothing changes
    r.sync.update();
    expect(r.bodyDress).toHaveBeenCalledTimes(1);
    wardrobe.takeOff('shirt');
    r.sync.update();
    expect(r.bodyDress).toHaveBeenCalledTimes(2);
    expect(r.bodyDress).toHaveBeenLastCalledWith({});
  });
  it('dresses a newly built hull (boat switch) in what is already worn', () => {
    const r = rig();
    wardrobe.set(buy(emptyInventory(), 'gifts', 'cap-bucket', 1e6, 0).inventory);
    r.sync.update();
    const captain2 = makeHuman({ ...base });
    const spy = vi.spyOn(captain2, 'dress');
    r.model.captain = captain2;
    // a different model object is what a rebuilt boat looks like to the sync
    const model2 = { captain: captain2, group: new THREE.Group(), setCosmeticFlag: vi.fn() };
    const sync2 = createOutfitSync({ body: () => null, model: () => model2, onBuilt: vi.fn() });
    sync2.update();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
