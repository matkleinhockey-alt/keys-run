/**
 * Water: depth/inlet texture, the ripple/foam/fog shader, and the boat-following mesh.
 *
 * Ported faithfully from legacy/index.html:610-706. The depth lookup grid itself
 * (`DEPTHG`/`INLETG`/`depthFast`/`ampAt`, index.html:617-625) now lives in
 * `@keysrun/shared/sim/depth-grid` (see that module's doc comment) so the water shader's
 * `depthTex` and the boat's buoyancy integrator read the exact same cache — this file only
 * bakes that shared grid into a three.js `DataTexture`.
 *
 * ⚠ KNOWN LANDMINE (docs/ARCHITECTURE.md): legacy's wake rings (`wakeP`, a module-level
 * `THREE.Vector4[]`) fed BOTH the GPU shader's visual ripple AND the JS buoyancy integrator's
 * `waveH`. Those are now two separate, synchronized things: the physics copy lives in
 * `BoatState.wakeRing` (plain numbers, packages/shared/src/sim/boat.ts); this module owns a
 * `THREE.Vector4[]` purely for the GPU uniform, and `syncWakeUniform` copies the former into the
 * latter once per frame (see entities/boat/visuals.ts). Only one boat exists in Phase 0, so this
 * is exactly legacy's single-boat behaviour.
 */
import * as THREE from 'three';
import { DEPTHG, INLETG, DG, DGN, DG0X, DG0Z } from '@keysrun/shared/sim/depth-grid';
import { WAKE_N } from '@keysrun/shared/sim/boat';
import { isTouch } from '../core/scene.js';
import { waterNoiseTex } from '../core/textures.js';

/** legacy `DSTOPS`/`depthRGB` (index.html:611-616) — unused elsewhere in legacy too (the GPU
 * shader has its own GLSL `depthCol`), kept for fidelity/future CPU-side use. */
const DSTOPS: Array<[number, [number, number, number]]> = [
  [0.3, [0.70, 0.94, 0.86]], [1.2, [0.45, 0.89, 0.83]], [3, [0.22, 0.79, 0.81]], [7, [0.12, 0.63, 0.75]],
  [15, [0.07, 0.49, 0.67]], [45, [0.05, 0.33, 0.56]], [150, [0.04, 0.22, 0.46]], [600, [0.03, 0.15, 0.37]],
];
const lerp3 = (a: number, b: number, t: number) => a + (b - a) * t;
export function depthRGB(d: number): [number, number, number] {
  if (d <= DSTOPS[0][0]) return DSTOPS[0][1];
  for (let i = 1; i < DSTOPS.length; i++) {
    if (d <= DSTOPS[i][0]) {
      const a = DSTOPS[i - 1], b = DSTOPS[i];
      const t = (Math.log(d) - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
      return [lerp3(a[1][0], b[1][0], t), lerp3(a[1][1], b[1][1], t), lerp3(a[1][2], b[1][2], t)];
    }
  }
  return DSTOPS[DSTOPS.length - 1][1];
}

function buildDepthTex(): THREE.DataTexture {
  const d = new Uint8Array(DGN * DGN * 4);
  const LG = Math.log2(401);
  for (let i = 0; i < DGN * DGN; i++) {
    d[i * 4] = Math.max(0, Math.min(255, Math.log2(DEPTHG[i] + 1) / LG * 255));
    d[i * 4 + 1] = Math.max(0, Math.min(255, INLETG[i] * 255));
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, DGN, DGN, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export interface WaterUniforms {
  uTime: { value: number };
  uSea: { value: number };
  uSW: { value: number };
  uCH: { value: number };
  uSky: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uNorm: { value: THREE.Texture };
  uDepth: { value: THREE.Texture };
  uDepthBox: { value: THREE.Vector4 };
  uWakeP: { value: THREE.Vector4[] };
}

export interface WaterHandles {
  water: THREE.Mesh;
  /** The underlying MeshStandardMaterial, exposed so core/shadows.ts can register it for cascaded
   * shadows without world/water.ts needing to know anything about CSM. */
  material: THREE.MeshStandardMaterial;
  /** The material's own, CSM-agnostic onBeforeCompile — see core/shadows.ts's header for why this
   * exact (stable) reference, rather than material.onBeforeCompile at call time, must be what
   * every CSM re-registration wraps. */
  baseOnBeforeCompile: THREE.MeshStandardMaterial['onBeforeCompile'];
  uniforms: WaterUniforms;
  recenter(x: number, z: number): void;
  update(t: number, sea: number, sw: number, ch: number): void;
  /** Mirror the boat's physics wake ring (plain numbers) into the GPU uniform's Vector4[]. */
  syncWakeUniform(ring: Float64Array): void;
  /** Rebuild the water plane at a new tessellation (quality tier change). Keeps the material/
   * uniforms — only the displaced grid of vertices is recreated. */
  setTessellation(segments: number): void;
}

const WR = 1900, WA = 0.11;

/** Non-uniform radial grid: dense near the camera, coarse toward the 1,900 m horizon — the same
 * `f(s)` warp legacy used, just factored out so quality-tier changes can rebuild it. */
function buildWaterGeometry(segments: number): THREE.BufferGeometry {
  const wGeo = new THREE.PlaneGeometry(2, 2, segments, segments);
  wGeo.rotateX(-Math.PI / 2);
  const p = wGeo.attributes.position;
  const f = (s: number) => Math.sign(s) * WR * (WA * Math.abs(s) + (1 - WA) * Math.abs(s) ** 3);
  for (let i = 0; i < p.count; i++) { p.setX(i, f(p.getX(i))); p.setZ(i, f(p.getZ(i))); }
  wGeo.computeBoundingSphere();
  return wGeo;
}

export function createWater(sunDir: THREE.Vector3, waterSegments?: number): WaterHandles {
  const touch = isTouch();
  const depthTex = buildDepthTex();
  const wakeVecs: THREE.Vector4[] = Array.from({ length: WAKE_N }, () => new THREE.Vector4(0, 0, -999, 0));

  const WN = waterSegments ?? (touch ? 150 : 220);
  const wGeo = buildWaterGeometry(WN);

  const uniforms: WaterUniforms = {
    uTime: { value: 0 }, uSea: { value: 1 }, uSW: { value: 1 }, uCH: { value: 1 },
    uSky: { value: new THREE.Color(0xb9d9e8) }, uSunDir: { value: sunDir.clone() },
    uNorm: { value: waterNoiseTex() }, uDepth: { value: depthTex },
    uDepthBox: { value: new THREE.Vector4(DG0X, DG0Z, DG, DGN) }, uWakeP: { value: wakeVecs },
  };

  const waterMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0.05, transparent: true });
  // Named (not an inline arrow assigned straight to onBeforeCompile) because core/shadows.ts's
  // CSM integration needs a stable reference to re-wrap from on every quality-tier switch — see
  // that module's header for why re-wrapping from "whatever onBeforeCompile is currently set"
  // instead would either nest indefinitely or lose this entirely after a CSM dispose().
  const baseOnBeforeCompile: THREE.MeshStandardMaterial['onBeforeCompile'] = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uSW; uniform float uCH; uniform sampler2D uDepth; uniform vec4 uDepthBox; uniform vec4 uWakeP[${WAKE_N}];
varying float vWA; varying vec3 vWN; varying vec3 vWP; varying float vCrest; varying float vSlope; varying vec3 vCol; varying float vWake;
void wv(vec2 P,float kx,float kz,float w,float A,float c,float ph,inout float h,inout vec2 d){ float p=kx*P.x+kz*P.y+w*uTime+ph; h+=A*(sin(p)-c*cos(2.*p)); d+=vec2(kx,kz)*A*(cos(p)+2.*c*sin(2.*p)); }
float ampForG(float d){ return .1+.9*clamp((d-1.)/40.,0.,1.)+1.*clamp((d-45.)/250.,0.,1.); }
vec3 depthCol(float d){ float l=log(max(d,.3));
  if(l<log(1.2)) return mix(vec3(.70,.94,.86),vec3(.45,.89,.83),clamp((l-log(.3))/(log(1.2)-log(.3)),0.,1.));
  if(l<log(3.)) return mix(vec3(.45,.89,.83),vec3(.22,.79,.81),(l-log(1.2))/(log(3.)-log(1.2)));
  if(l<log(7.)) return mix(vec3(.22,.79,.81),vec3(.12,.63,.75),(l-log(3.))/(log(7.)-log(3.)));
  if(l<log(15.)) return mix(vec3(.12,.63,.75),vec3(.07,.49,.67),(l-log(7.))/(log(15.)-log(7.)));
  if(l<log(45.)) return mix(vec3(.07,.49,.67),vec3(.05,.33,.56),(l-log(15.))/(log(45.)-log(15.)));
  if(l<log(150.)) return mix(vec3(.05,.33,.56),vec3(.04,.22,.46),(l-log(45.))/(log(150.)-log(45.)));
  return mix(vec3(.04,.22,.46),vec3(.03,.15,.37),clamp((l-log(150.))/(log(600.)-log(150.)),0.,1.)); }
float wakeH(vec2 P,inout vec2 grad,inout float foam){ float h=0.;
  for(int i=0;i<${WAKE_N};i++){ vec4 w=uWakeP[i]; if(w.w<=0.) continue; float age=uTime-w.z; if(age<0.||age>22.) continue;
    float cq=floor(w.w/10.); float c=cq/10.; float A=w.w-cq*10.;
    vec2 dv=P-w.xy; float r=length(dv); float R=c*age+1.2; float dr=r-R; float wd=1.6+age*.3; if(abs(dr)>wd*3.) continue;
    float g=exp(-dr*dr/(wd*wd)), k=2.4/wd, dec=A*exp(-age/9.)/(1.+R*.03);
    h+=dec*g*cos(k*dr); grad+=dec*g*(-2.*dr/(wd*wd)*cos(k*dr)-k*sin(k*dr))*dv/max(r,.01);
    foam+=dec*g*max(0.,1.-age/4.); }
  return h; }`)
      .replace('#include <beginnormal_vertex>', `
    vec4 wpW=modelMatrix*vec4(position,1.0);
    vec4 dtx=texture2D(uDepth,((wpW.xz-uDepthBox.xy)/uDepthBox.z+.5)/uDepthBox.w);
    float dep=exp2(dtx.r*8.6474)-1.;
    float wAmp=ampForG(dep)*(1.+.9*dtx.g);
    vCol=depthCol(dep); vWA=clamp(.36+.4*log(dep+1.)/log(30.),.36,.72);
    float hh=0.; vec2 dd=vec2(0.); float chv=min(uCH,2.2);
    wv(wpW.xz,.0114,.0262,.53,.62*uSW,.12,0.,hh,dd); wv(wpW.xz,.0302,.0322,.66,.32*uSW,.16,1.7,hh,dd);
    wv(wpW.xz,.074,.046,.93,.13*chv,.28,2.4,hh,dd); wv(wpW.xz,-.052,.092,1.02,.09*chv,.25,.6,hh,dd); wv(wpW.xz,.0205,.0178,.516,.45*uSW,.1,3.1,hh,dd); wv(wpW.xz,-.0128,.0251,.526,.35*uSW,.1,4.4,hh,dd);
    float cfd=1.-smoothstep(260.,700.,length(wpW.xz-cameraPosition.xz)); wv(wpW.xz,.118,.071,1.162,.06*chv*cfd,.3,1.1,hh,dd); wv(wpW.xz,-.09,.13,1.244,.05*chv*cfd,.3,5.2,hh,dd);
    float wh=wAmp*hh; dd*=wAmp;
    vec2 wg=vec2(0.); float wf=0.; wh+=wakeH(wpW.xz,wg,wf); dd+=wg; vWake=wf;
    vec3 objectNormal=normalize(vec3(-dd.x,1.0,-dd.y));
    vWN=objectNormal; vWP=vec3(wpW.x,wh,wpW.z); vCrest=hh/(1.74*uSW+.33*chv+.001); vSlope=length(dd);
    // Keys turquoise is the single most recognisable thing about this look, and ACES tone mapping
    // desaturates everything that goes through it — boost chroma here (away from the per-vertex
    // luma, so brightness is unaffected) to compensate, instead of letting the depth-colour ramp
    // read as flat grey-teal post-tonemap.
    float vColLm=dot(vCol,vec3(.299,.587,.114)); vCol=mix(vec3(vColLm),vCol,1.55);`)
      .replace('#include <begin_vertex>', 'vec3 transformed=vec3(position.x,wh,position.z);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uSea; uniform float uCH; uniform vec3 uSky; uniform vec3 uSunDir; uniform sampler2D uNorm; varying float vWA; varying vec3 vWN; varying vec3 vWP; varying float vCrest; varying float vSlope; varying vec3 vCol; varying float vWake;')
      .replace('#include <color_fragment>', `#include <color_fragment>
    vec4 tz=texture2D(uNorm,vWP.xz*.021+vec2(uTime*.006,-uTime*.004));
    float breakup=texture2D(uNorm,vWP.xz*.06+vec2(-uTime*.02,uTime*.013)).a;
    diffuseColor.rgb=vCol*(.9+.2*tz.b);
    float foam=smoothstep(.58,.95,vCrest)*smoothstep(.6,1.4,uCH)*smoothstep(.35,.7,breakup*.8+tz.a*.4);
    foam=max(foam,smoothstep(.12,.25,vSlope)*smoothstep(.4,.75,breakup)*.8);
    foam=max(foam,smoothstep(.04,.28,vWake)*smoothstep(.2,.6,breakup+.15));
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.95,.97,1.),foam);
    diffuseColor.a=mix(vWA,1.,foam);`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
    float rfade=1.-smoothstep(60.,520.,length(cameraPosition-vWP));
    vec2 n1=texture2D(uNorm,vWP.xz*.045+vec2(uTime*.018,uTime*.011)).rg*2.-1.;
    vec2 n2=texture2D(uNorm,vWP.xz*.12+vec2(-uTime*.03,uTime*.022)).rg*2.-1.;
    vec2 n3=texture2D(uNorm,vWP.xz*.008+vec2(uTime*.004,-uTime*.006)).rg*2.-1.;
    vec3 rippleW=vec3(n1.x+n2.x*.7,0.,n1.y+n2.y*.7)*.22*(.55+.45*min(uSea,2.))*rfade+vec3(n3.x,0.,n3.y)*.12;
    normal=normalize(normal+(viewMatrix*vec4(rippleW,0.)).xyz);`)
      .replace('#include <fog_fragment>', `
    vec3 Vw=normalize(cameraPosition-vWP); vec3 Nw=normalize(vWN+rippleW*1.4);
    float fres=.03+.97*pow(1.-clamp(dot(Nw,Vw),0.,1.),5.);
    gl_FragColor.rgb=mix(gl_FragColor.rgb,uSky,fres*.7);
    gl_FragColor.a=mix(gl_FragColor.a,1.,fres);
    // Sun specular: legacy's single moderate-exponent term, kept as-is deliberately. An earlier
    // version of this file stacked a second (wider) lobe plus a sparkle term on top at a much
    // higher exponent (420 vs 380 here) and additionally boosted the fresnel sky-mix — both caught
    // on review as visible regressions against the legacy screenshots (over-bright, and washing out
    // the CSM shadow on water entirely). Reverted rather than patched further, since the plain
    // version already matches legacy's look and shows the shadow fine on its own. NOTE: the
    // separate blocky/faceted wake-foam regression reported alongside this turned out to be the
    // particle spray system, not this shader at all — see world/particles.ts's and
    // entities/boat/visuals.ts's comments for that fix.
    float spk=pow(max(dot(Nw,normalize(Vw+uSunDir)),0.),380.);
    gl_FragColor.rgb+=vec3(1.,.95,.84)*spk*2.4;
    #include <fog_fragment>`);
  };
  waterMat.onBeforeCompile = baseOnBeforeCompile;

  const water = new THREE.Mesh(wGeo, waterMat);
  water.receiveShadow = true;
  water.renderOrder = 1;

  return {
    water,
    material: waterMat,
    baseOnBeforeCompile,
    uniforms,
    recenter(x, z) { water.position.set(Math.round(x / 2) * 2, 0, Math.round(z / 2) * 2); },
    update(t, sea, sw, ch) { uniforms.uTime.value = t; uniforms.uSea.value = sea; uniforms.uSW.value = sw; uniforms.uCH.value = ch; },
    setTessellation(segments) {
      const next = buildWaterGeometry(segments);
      water.geometry.dispose();
      water.geometry = next;
    },
    syncWakeUniform(ring) {
      for (let i = 0; i < WAKE_N; i++) {
        const o = i * 4;
        wakeVecs[i].set(ring[o], ring[o + 1], ring[o + 2], ring[o + 3]);
      }
    },
  };
}
