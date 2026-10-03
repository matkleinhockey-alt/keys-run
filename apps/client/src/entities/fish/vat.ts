/**
 * Vertex animation texture (VAT) baking — docs/ARCHITECTURE.md "Fish at realism *and* density":
 * "School — vertex animation textures: bake the swim cycle into a texture, render the whole
 * school as one InstancedMesh with per-instance animation phase. This is what makes dense
 * realistic schools possible at all."
 *
 * The swim cycle (swim.ts) is, per vertex, `amp[i] * sin(theta - phase[i])` where `theta` is a
 * single global angle that advances at `angSpeed` rad/s. That function is periodic in `theta`
 * with period 2*PI, so sampling it at `frameCount` evenly spaced phases over exactly one period
 * bakes a texture that tiles seamlessly forever — no discontinuity at the loop seam, no drift.
 * Each instance gets its own look purely from a per-instance *phase offset* added to `theta`
 * before the lookup (materials.ts's `iPhase` instanced attribute) — legacy achieved the same
 * per-instance desync by reading each instance's world position in the vertex shader
 * (`ipos.x*.37+ipos.y*.23`); baking removes the need for that instanceMatrix read entirely.
 *
 * Texture layout: width = vertex count, height = `frameCount`, one float per texel (R channel):
 * `data[frame*vertexCount + vertex] = amp[vertex] * sin(2*PI*frame/frameCount - phase[vertex])`.
 * Sampled with NearestFilter (no hardware float-linear-filtering dependency — this environment's
 * software/virtualised GPU is exactly the kind of target that extension can be missing on) and
 * manually lerped between the two bracketing frames in the shader for a smooth loop at a modest
 * frame count (see materials.ts).
 */
import * as THREE from 'three';
import type { SwimProfile } from './swim.js';

export interface VatBake {
  texture: THREE.DataTexture;
  frameCount: number;
  vertexCount: number;
  axis: SwimProfile['axis'];
  angSpeed: number;
}

export const DEFAULT_VAT_FRAMES = 24;

export function bakeVAT(profile: SwimProfile, frameCount = DEFAULT_VAT_FRAMES): VatBake {
  const n = profile.amp.length;
  const data = new Float32Array(n * frameCount);
  const twoPi = Math.PI * 2;
  for (let k = 0; k < frameCount; k++) {
    const theta = (k / frameCount) * twoPi;
    const row = k * n;
    for (let i = 0; i < n; i++) data[row + i] = profile.amp[i] * Math.sin(theta - profile.phase[i]);
  }
  const texture = new THREE.DataTexture(data, n, frameCount, THREE.RedFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, frameCount, vertexCount: n, axis: profile.axis, angSpeed: profile.angSpeed };
}

/** Attaches the one per-vertex attribute the VAT lookup needs: its own column index. Everything
 * else that used to be a per-vertex attribute (`wig`/`wigY`/`wph`) is now baked into the texture
 * and needed nowhere at runtime. */
export function attachVertexIndex(geo: THREE.BufferGeometry): void {
  const n = geo.attributes.position.count;
  const idx = new Float32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  geo.setAttribute('vIdx', new THREE.Float32BufferAttribute(idx, 1));
}
