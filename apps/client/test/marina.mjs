/**
 * The marina the capture scripts tie up at, read from the game's own data.
 *
 * Every one of these scripts used to carry `const SX = -900, SZ = 250.7;` copied by hand. The
 * marina moved and the copies did not: 250.7 is 148 m adrift of the real 102.6728, so every
 * position derived from it landed out to sea. That went unnoticed for a long time because the
 * scripts still ran — they just photographed empty water, and an interiors run reported every
 * venue in town as `built=false`, including ones nobody had touched.
 *
 * So it is imported, not copied. @keysrun/shared is a dependency of this app and resolves from a
 * plain node script, so there is no reason for a second copy of a number to exist.
 */
import { MARINAS } from '@keysrun/shared/world/depth';

const BOOT_KEY = MARINAS.find((m) => m.sx === -900) ?? MARINAS[0];

/** Boot Key Harbor City Marina: where the player spawns and most captures start. */
export const SX = BOOT_KEY.sx;
export const SZ = BOOT_KEY.sz;
/** Which way the marina faces out to sea (+1 south, -1 north). */
export const SDIR = BOOT_KEY.dir;
