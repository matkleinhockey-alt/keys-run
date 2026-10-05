/**
 * The one shared "which way is the water moving right now" uniform block, in the same spirit as
 * entities/fish/swim-clock.ts: every card material built by materials.ts points its own uniforms
 * at these exact objects, so a single per-frame update drives every swaying weed in the world
 * instead of walking a material list.
 *
 * Flow is sampled at **the viewer**, not per instance. Underwater visibility is 10-30 m
 * (world/underwater/depth-bands.ts), and `currentAt` varies on a scale of hundreds of metres, so
 * every weed you can actually see at once is in sensibly the same flow. Sampling once per frame
 * and passing two floats beats evaluating the field per vertex, and the difference is
 * unobservable.
 *
 * The travelling-wave character of surge is *not* lost by sampling at a point: `uSurgePhase`
 * carries the phase, and the shader offsets it per instance by world position (materials.ts), so
 * a bed still ripples in sequence rather than pulsing as one.
 */
import * as THREE from 'three';
import { depthAt } from '@keysrun/shared/world/depth';
import { steadyCurrentAt, chainNormal, SURGE_MAX_SPEED, SURGE_DECAY_DEPTH } from '@keysrun/shared/world/current';

/** Steady flow direction x speed (m/s) in world XZ — the Florida Current plus the tide. Weeds
 * lean into this and stay leaning. */
export const uFlow = { value: new THREE.Vector2(0, 0) };
/** Cross-shore unit axis the surge oscillates along. */
export const uSurgeAxis = { value: new THREE.Vector2(0, 1) };
/** Surge phase in radians, advanced by real time; the shader adds a per-instance spatial offset. */
export const uSurgePhase = { value: 0 };
/** Peak surge displacement scale at this depth, 0 when deep enough that orbital motion is dead. */
export const uSurgeAmp = { value: 0 };

/** Surge period, seconds — matches `SURGE_PERIOD_S` in @keysrun/shared/world/current. */
const SURGE_PERIOD_S = 7.5;

/**
 * Samples the current at the viewer and republishes it as uniforms. Call once per frame with the
 * camera's world position and the sim clock.
 *
 * `depthAt` is evaluated once here rather than threaded in, because the one caller
 * (world/reef/index.ts) does not otherwise need it and the cost is a single closed-form
 * evaluation per frame.
 */
export function updateFlowUniforms(x: number, z: number, t: number): void {
  const steady = steadyCurrentAt(x, z, t);
  uFlow.value.set(steady.vx, steady.vz);

  const { nx, nz } = chainNormal(x);
  uSurgeAxis.value.set(nx, nz);
  uSurgePhase.value = (t / SURGE_PERIOD_S) * Math.PI * 2;
  uSurgeAmp.value = SURGE_MAX_SPEED * Math.exp(-Math.max(0, depthAt(x, z)) / SURGE_DECAY_DEPTH);
}
