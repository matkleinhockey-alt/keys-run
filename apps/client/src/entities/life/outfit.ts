/**
 * Cosmetics, client side: what the player is wearing, and putting it on the figures that show it.
 *
 * ## Where the truth lives
 * `Inventory.wearing` (packages/shared sim/shop.ts) is the one record of what is on. This module holds
 * the `Inventory` the wardrobe reads from -- `wardrobe.set(inv)` is how the gear/inventory screen
 * (or the till, after `buy()`) hands it over, and `wear`/`takeOff` here are thin wrappers over the
 * pure functions in sim/wardrobe.ts that then publish. It deliberately stores nothing that is not
 * already in an `Inventory`: no parallel list of "equipped" ids. Until the inventory screen owns the
 * live inventory this is its default home, and replacing it is a one-line `wardrobe.set(theirs)`.
 *
 * ## Why rebuild, not hide/show parts
 * `makeHuman` bakes shirt colours into a vertex-coloured torso and merges the head (cap, shades) into
 * one geometry, so a whole body is 3 draw calls. Swapping layers on and off would mean either extra
 * meshes per wearer or a material per item; rebuilding the two merged geometries on a *change*
 * (`Human.dress`) keeps the figure at 3 draw calls forever and costs nothing between changes.
 *
 * ## Cost when nothing is worn
 * `syncOutfit` is a string compare per target per frame (O(1)); with nothing worn the signature is
 * '|||' and never changes, so no geometry is built, no flag exists, and `updateHumans`' 160 m culling
 * is untouched because dressing never touches `update`.
 *
 * ## Why only the player's own figures
 * Dressed: the walking body ashore (entities/land) and the captain aboard (BoatModel.captain, plus the
 * stern flag). NPCs, deck-party guests, other players' boats and AI racers keep their own looks --
 * remote players' outfits would need the server to carry `wearing`, which it does not yet.
 */
import * as THREE from 'three';
import { COSMETICS, type CosmeticSlot, type FlagLook } from '@keysrun/shared/content/cosmetics';
import { emptyInventory, type Inventory } from '@keysrun/shared/sim/shop';
import { outfitOf, outfitSignature, takeOff as takeOffInv, wear as wearInv } from '@keysrun/shared/sim/wardrobe';
import type { Human, HumanDress } from './human.js';

type Outfit = Partial<Record<CosmeticSlot, string>>;

/* ------------------------------------------------------------------------------------------- *
 * The store
 * ------------------------------------------------------------------------------------------- */

let inventory: Inventory = emptyInventory();
const listeners = new Set<() => void>();

export const wardrobe = {
  get(): Inventory { return inventory; },
  set(inv: Inventory): void {
    inventory = inv;
    listeners.forEach((f) => f());
  },
  wear(key: string): void { this.set(wearInv(inventory, key)); },
  takeOff(slot: string): void { this.set(takeOffInv(inventory, slot)); },
  subscribe(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
};

/* ------------------------------------------------------------------------------------------- *
 * Outfit -> figure
 * ------------------------------------------------------------------------------------------- */

/** The `makeHuman` option overrides for an outfit. Later slots win only where they set something, so
 * a shirt never clobbers a cap. */
export function dressFor(outfit: Outfit): HumanDress {
  const d: HumanDress = {};
  for (const slot of ['shirt', 'cap', 'glasses'] as const) {
    const key = outfit[slot];
    const look = key ? COSMETICS[key]?.human : undefined;
    if (look) Object.assign(d, look);
  }
  // Worn shades are always `glasses: true`; the base figures already have glasses, but a figure built
  // without them (the walking body has them) would otherwise ignore an item the player bought.
  if (outfit.glasses) d.glasses = true;
  return d;
}

/** Paints a flag's stripes, disc and letter. 2:1-ish canvas, small: it is stretched over ~1 m of cloth. */
export function paintFlag(look: FlagLook): THREE.CanvasTexture {
  const W = 256, H = 160, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const css = (n: number): string => '#' + n.toString(16).padStart(6, '0');
  look.stripes.forEach((col, i) => { x.fillStyle = css(col); x.fillRect(0, (i * H) / look.stripes.length, W, H / look.stripes.length + 1); });
  if (look.disc !== undefined) { x.fillStyle = css(look.disc); x.beginPath(); x.arc(W / 2, H / 2, H * 0.3, 0, Math.PI * 2); x.fill(); }
  if (look.letter) {
    x.fillStyle = css(look.letter.color);
    x.font = `900 ${Math.round(H * 0.78)}px Georgia, serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(look.letter.ch, W / 2, H * 0.54);
  }
  x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 4; x.strokeRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------------------------------- *
 * Keeping the figures in step with the wardrobe
 * ------------------------------------------------------------------------------------------- */

export interface OutfitTargets {
  /** The walking body ashore, or null before it has been built. */
  body(): Human | null;
  /** The boat the player is driving. A different object than last frame means a new hull was built
   * (boat switch), whose captain has the stock look and no flag. */
  model(): { captain: Human; group: THREE.Object3D; setCosmeticFlag(tex: THREE.Texture | null): void };
  /** Runs the cascaded-shadow sweep over newly made materials (dressing creates sleeve materials). */
  onBuilt(root: THREE.Object3D): void;
}

/**
 * Call once per frame. Per frame it does two pointer compares and (only when the inventory object
 * itself was replaced) re-derives the outfit signature; it rebuilds a figure only when that figure's
 * signature differs from the outfit.
 */
export function createOutfitSync(t: OutfitTargets): { update(): void } {
  // What each figure is currently wearing, as a signature. A figure we have not seen is assumed to be
  // in the stock look ('|||'), because that is what makeHuman/makeBoat build -- so a new body or a
  // new hull with nothing worn costs a string compare, not a rebuild.
  const STOCK = outfitSignature({});
  let body: Human | null = null, bodySig = STOCK;
  let model: ReturnType<OutfitTargets['model']> | null = null, modelSig = STOCK;
  let seenInv: Inventory | null = null, outfit: Outfit = {}, sig = STOCK;
  return {
    update(): void {
      const b = t.body(), m = t.model();
      if (b !== body) { body = b; bodySig = STOCK; }
      if (m !== model) { model = m; modelSig = STOCK; }
      if (inventory !== seenInv) { seenInv = inventory; outfit = outfitOf(inventory); sig = outfitSignature(outfit); }
      if (b && bodySig !== sig) {
        b.dress(dressFor(outfit)); t.onBuilt(b.group); bodySig = sig;
      }
      if (modelSig !== sig) {
        m.captain.dress(dressFor(outfit));
        const fl = outfit.flag ? COSMETICS[outfit.flag]?.flag : undefined;
        m.setCosmeticFlag(fl ? paintFlag(fl) : null);
        t.onBuilt(m.group); modelSig = sig;
      }
    },
  };
}
