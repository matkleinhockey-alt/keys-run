/**
 * The diver's seam to the player's gear. Another agent owns the inventory and its persistence; this
 * file is the ONLY place the diver reads it, so wiring the real thing is one assignment:
 *
 *     setDiverGearSource(() => ({ mods: modifiersFor(inv, simTime), hasTank: has(inv, 'dive.tank'),
 *                                 fills: countOf(inv, 'dive.fill') }));
 *     setDiverFillSpender(() => { inv = useOne(inv, 'dive.fill'); });
 *
 * Until then the default is "no gear", so the game behaves exactly as before. The dev hook
 * `window.__diverGear` lets the browser check (and QA) fake an inventory without the shop UI.
 */
import { NO_GEAR, type DiveGear } from '@keysrun/shared/sim/dive-gear';

let source: () => DiveGear = () => NO_GEAR;
let spend: () => void = () => {};

export const setDiverGearSource = (fn: () => DiveGear): void => { source = fn; };
export const setDiverFillSpender = (fn: () => void): void => { spend = fn; };
export const readDiverGear = (): DiveGear => source();
export const spendDiverFill = (): void => spend();

/** Dev/QA hook (same convention as __fishDebug): fake inventory for the dive check. */
if (typeof window !== 'undefined') {
  const fake = { gear: { ...NO_GEAR } as DiveGear, spent: 0 };
  (window as unknown as { __diverGear: unknown }).__diverGear = {
    set(g: Partial<DiveGear['mods']> & { hasTank?: boolean; fills?: number }) {
      fake.gear = {
        mods: { breathMul: g.breathMul ?? 1, swimMul: g.swimMul ?? 1, viewBonusM: g.viewBonusM ?? 0 },
        hasTank: g.hasTank ?? false, fills: g.fills ?? 0,
      };
      fake.spent = 0;
      setDiverGearSource(() => fake.gear);
      setDiverFillSpender(() => { fake.gear = { ...fake.gear, fills: Math.max(0, fake.gear.fills - 1) }; fake.spent++; });
    },
    get: () => ({ ...fake.gear, spent: fake.spent }),
  };
}
