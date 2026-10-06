/**
 * three.js ships the CSM (cascaded shadow map) addon as plain JS under examples/jsm with no
 * accompanying .d.ts (unlike the core package, which @types/three covers) — this is a minimal
 * ambient declaration for the surface core/shadows.ts actually uses.
 */
declare module 'three/addons/csm/CSM.js' {
  import type { DirectionalLight, Material, Object3D, PerspectiveCamera, Vector3 } from 'three';

  export interface CSMData {
    camera: PerspectiveCamera;
    parent: Object3D;
    cascades?: number;
    maxFar?: number;
    mode?: 'practical' | 'uniform' | 'logarithmic' | 'custom';
    shadowMapSize?: number;
    shadowBias?: number;
    lightDirection?: Vector3;
    lightIntensity?: number;
    lightNear?: number;
    lightFar?: number;
    lightMargin?: number;
  }

  export class CSM {
    constructor(data: CSMData);
    camera: PerspectiveCamera;
    parent: Object3D;
    cascades: number;
    maxFar: number;
    lights: DirectionalLight[];
    lightDirection: Vector3;
    fade: boolean;
    breaks: number[];
    shaders: Map<Material, unknown>;
    update(): void;
    updateFrustums(): void;
    setupMaterial(material: Material): void;
    remove(): void;
    dispose(): void;
  }
}

declare module 'three/addons/csm/CSMShader.js' {
  export const CSMShader: { lights_fragment_begin: string; lights_pars_begin: string };
}
