/**
 * What each cosmetic LOOKS like, as plain data. The shop sells the key; this says what the key means
 * to a renderer.
 *
 * ## Why this lives in shared (and holds no three.js)
 * Three consumers need the same table: the client renderer (turns a look into `HumanOptions` and a
 * flag texture), the gear/inventory screen (needs a name, a slot and a swatch to draw a row), and the
 * tests (every item the town sells must have a look, or it is a shelf item that does nothing). Colours
 * are bare 0xRRGGBB numbers and patterns are string tags, so nothing here touches three.js (CI-enforced
 * for this package) and the client owns every actual mesh.
 *
 * ## Deliberately NOT in sim/shop.ts's `Modifiers`
 * Cosmetics are the one kind of purchase with NO gameplay effect, on purpose. A lucky shirt that bit
 * the fish faster would turn the gift shop into a second tackle shop and make "what am I wearing" a
 * balance question, which is the opposite of the joke. `modifiersFor` therefore never reads
 * `inv.cosmetics`/`inv.wearing`, and test/wardrobe.test.ts pins that (a fully dressed player's
 * modifier bag equals NO_MODIFIERS). If you are about to "fix" that by adding a bonus here: do not.
 */

/** One worn item per slot (`slotOf(key)` in sim/shop.ts is the slot name). */
export type CosmeticSlot = 'shirt' | 'cap' | 'glasses' | 'flag';

export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ['shirt', 'cap', 'glasses', 'flag'];

/** Torso patterns the client paints into vertex colours (no textures, no extra draw calls). */
export type ShirtPattern = 'hawaiian' | 'stripe' | 'fade';

export interface HumanLook {
  /** Main torso colour. */
  shirt?: number;
  /** Second colour for the pattern (flowers, stripes, the bottom of a fade). */
  shirtAccent?: number;
  shirtPattern?: ShirtPattern;
  cap?: number;
  capStyle?: 'ball' | 'bucket';
  glassesColor?: number;
  glassesStyle?: 'wide' | 'round' | 'aviator';
}

/** A boat flag: horizontal stripes, an optional disc and an optional big letter. Painted on a canvas
 * by the client. */
export interface FlagLook {
  stripes: readonly number[];
  disc?: number;
  letter?: { ch: string; color: number };
}

export interface Cosmetic {
  slot: CosmeticSlot;
  name: string;
  /** A representative colour for list rows. */
  swatch: number;
  human?: HumanLook;
  flag?: FlagLook;
}

export const COSMETICS: Readonly<Record<string, Cosmetic>> = {
  'cosmetic.shirt.hawaiian': { slot: 'shirt', name: 'Loud Hawaiian shirt', swatch: 0xe8453c, human: { shirt: 0xf0a01c, shirtAccent: 0xd7263d, shirtPattern: 'hawaiian' } },
  'cosmetic.shirt.breton': { slot: 'shirt', name: 'Breton stripe tee', swatch: 0x1d3557, human: { shirt: 0xf2efe6, shirtAccent: 0x1d3557, shirtPattern: 'stripe' } },
  'cosmetic.shirt.sunset': { slot: 'shirt', name: 'Sunset fade tee', swatch: 0xf28c38, human: { shirt: 0xffd166, shirtAccent: 0xc2185b, shirtPattern: 'fade' } },
  'cosmetic.shirt.luigi': { slot: 'shirt', name: 'Green polo', swatch: 0x2e9b3f, human: { shirt: 0x2e9b3f } },

  'cosmetic.cap.conch': { slot: 'cap', name: 'Conch Republic cap', swatch: 0xf4a58a, human: { cap: 0xf4a58a } },
  'cosmetic.cap.bucket': { slot: 'cap', name: 'Khaki bucket hat', swatch: 0xc9b37a, human: { cap: 0xc9b37a, capStyle: 'bucket' } },
  'cosmetic.cap.luigi': { slot: 'cap', name: 'Green cap', swatch: 0x2e9b3f, human: { cap: 0x2e9b3f } },

  'cosmetic.glasses.aviator': { slot: 'glasses', name: 'Gold aviators', swatch: 0xd8b84a, human: { glassesColor: 0x3a3320, glassesStyle: 'aviator' } },
  'cosmetic.glasses.round': { slot: 'glasses', name: 'Round shades', swatch: 0x2a2a2e, human: { glassesColor: 0x14213d, glassesStyle: 'round' } },
  'cosmetic.glasses.neon': { slot: 'glasses', name: 'Neon wraparounds', swatch: 0xff3ea5, human: { glassesColor: 0xff3ea5, glassesStyle: 'wide' } },

  'cosmetic.flag.conch': { slot: 'flag', name: 'Conch Republic flag', swatch: 0x1b4f9c, flag: { stripes: [0x1b4f9c], disc: 0xf6c945 } },
  'cosmetic.flag.fishon': { slot: 'flag', name: '"Fish On" pennant', swatch: 0xd7263d, flag: { stripes: [0xd7263d, 0xf6f1e7, 0xd7263d] } },
  'cosmetic.flag.loser': { slot: 'flag', name: 'White flag (the seagull is right)', swatch: 0xf6f1e7, flag: { stripes: [0xf6f1e7], letter: { ch: 'L', color: 0x15171a } } },
};
