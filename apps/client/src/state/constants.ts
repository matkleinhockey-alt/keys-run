/**
 * Client-side constants that don't belong in @keysrun/shared because they're presentation
 * concerns (a fixed world seed for *cosmetic* scatter — vegetation, coral, mooring balls — and
 * the salts that keep each scatter system's hash stream independent of every other one).
 *
 * Per docs/ARCHITECTURE.md "Seeding": placement here is position/index-derived via
 * `hashCell(WORLD_SEED, cx, cz, salt)`, never iteration-order Math.random() — so adding one
 * object to one system never reshuffles any other system, or even later objects in the same
 * system. `WORLD_SEED` is unrelated to legacy's island-placement `srand(seed=11)`, which is
 * kept byte-for-byte as-is (see @keysrun/shared/world/chain.ts's `createSrand`/`islands`).
 */

export const WORLD_SEED = 20240817;

/** legacy `SPAWN` (index.html:367): open water in Boot Key Harbor, clear of the marinas. */
export const SPAWN_X = -1150;
export const SPAWN_DZ = 305;
export const SPAWN_H = Math.PI / 2;

/** One salt per independent scatter attribute. Grouped by system; values just need to be distinct. */
export const SALT = {
  PALM_ANG: 101, PALM_R: 102, PALM_SKIP: 103, PALM_HEIGHT: 104, PALM_TILT_X: 105, PALM_TILT_Z: 106,
  PALM_SKIP_CITY: 107,
  HOUSE_ANG: 111, HOUSE_R: 112, HOUSE_ROT: 113, HOUSE_COLOR: 114,
  MANGROVE_ANG: 121, MANGROVE_SIZE: 122, MANGROVE_CREEK_SIZE: 123,
  CORAL_MAIN_X: 131, CORAL_MAIN_Z: 132,
  CORAL_PATCH_X: 133, CORAL_PATCH_Z: 134,
  CORAL_CLUSTER_CX: 135, CORAL_CLUSTER_CZ: 136, CORAL_CLUSTER_X: 137, CORAL_CLUSTER_Z: 138,
  CORAL_SCALE: 139, CORAL_SCALE_X: 140, CORAL_SCALE_Z: 141, CORAL_ROT_X: 142, CORAL_ROT_Y: 143,
  CORAL_FAN_DX: 144, CORAL_FAN_DZ: 145, CORAL_FAN_ROT: 146, CORAL_FAN_SCALE: 147,
  MOORING_REEF_X: 151, MOORING_REEF_Z: 152,
  MOORING_HARBOR_X: 153, MOORING_HARBOR_Z: 154, MOORING_HARBOR_ROT: 155,
  // World life (entities/life/**) — hotspots and weedlines are gameplay-relevant world content
  // (docs/ARCHITECTURE.md "Determinism": "gameplay-relevant placement is computed ... from the
  // shared seed" so every player sees the same birds-and-bait spot) and must not depend on
  // Math.random()/iteration order. Rigs are 4 fixed coordinates in legacy — no salt needed.
  HOTSPOT_CREEK_PICK: 161, HOTSPOT_CREEK_FRAC: 162, HOTSPOT_HUMP_PICK: 163,
  HOTSPOT_X: 164, HOTSPOT_Z: 165,
  WEED_X: 171, WEED_Z: 172, WEED_ANG: 173, WEED_LEN: 174, WEED_WID: 175, WEED_HUMP_OFFX: 176, WEED_HUMP_OFFZ: 177,
} as const;
