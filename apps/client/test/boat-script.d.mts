/**
 * Types for boat-script.mjs.
 *
 * Hand-written because that file has to stay plain JavaScript: `boat-baseline.mjs` runs it
 * straight from `node` to regenerate the baseline, with no TypeScript toolchain in the loop.
 */
import type { BoatState, DockRect, Piling } from '@keysrun/shared/sim/boat';

export declare const DT: number;
export declare const HULL: { len: number; beam: number; top: number; accel: number; turn: number; draft: number };
export declare const SPAWN_X: number;
export declare const SPAWN_Z: number;
export declare const SPAWN_H: number;

export interface ScriptStep {
  fwd: boolean; back: boolean; left: boolean; right: boolean;
  trimUp: boolean; trimDn: boolean;
  gear: BoatState['gear']; trimMode: boolean;
  sw: number; ch: number;
}
export declare const SCRIPT: ScriptStep[];
export declare function buildScript(): ScriptStep[];

export interface BaselineStep { x: number; z: number; h: number; speed: number; y: number; pitch: number; roll: number }
export interface RunResult { steps: BaselineStep[]; events: Record<string, number> }

export declare function run(dockRects: readonly DockRect[], pilings: readonly Piling[]): RunResult;
export declare function waypoints(): { dock: DockRect; piling: Piling };
export declare function buildBaseline(): RunResult & { dock: DockRect; piling: Piling };
