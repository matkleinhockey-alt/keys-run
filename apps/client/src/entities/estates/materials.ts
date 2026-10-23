/**
 * The estates' shared materials, built once on first use and never disposed: every estate and
 * every rebuild of one shares them, so a rebuild only ever frees geometry (see index.ts's
 * `disposeEstate`). Anything per-estate that owns a texture (signs) marks itself
 * `userData.ownMat` so the disposer frees that material too.
 */
import * as THREE from 'three';

const std = (color: number, o: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, ...o });

let cache: ReturnType<typeof build> | null = null;

function build() {
  return {
    stucco: std(0xf6efe2),
    stuccoPink: std(0xf7c6d0),
    stuccoBlue: std(0xb9d4f5),
    terracotta: std(0xc8643c, { roughness: 0.7 }),
    slate: std(0x3b3f45, { roughness: 0.6 }),
    tin: std(0xaeb4ba, { metalness: 0.6, roughness: 0.4 }),
    rust: std(0x9a5a34),
    wood: std(0x8a6a48),
    darkWood: std(0x5c4a38),
    deck: std(0xb08a5e, { roughness: 0.9 }),
    white: std(0xffffff, { roughness: 0.5 }),
    trim: std(0x2a2d31, { roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x8fc4dc, metalness: 0.9, roughness: 0.08, transparent: true, opacity: 0.55 }),
    window: std(0x1d3346, { metalness: 0.5, roughness: 0.2 }),
    water: new THREE.MeshStandardMaterial({ color: 0x3fb8d8, metalness: 0.2, roughness: 0.05, emissive: 0x0b4a5c, emissiveIntensity: 0.35 }),
    koiWater: new THREE.MeshStandardMaterial({ color: 0x2f6f5e, roughness: 0.1, metalness: 0.2 }),
    koi: std(0xf26b1d, { roughness: 0.4 }),
    gravel: std(0xd9d4c4, { roughness: 1 }),
    stone: std(0x9a958a),
    lawn: std(0x6e9a4a, { roughness: 1 }),
    hedge: std(0x2f5a2a),
    steel: new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.85, roughness: 0.25 }),
    red: std(0xc8102e, { roughness: 0.4 }),
    cooler: std(0xf4f4f2),
    coolerLid: std(0x2f8fd8),
    fire: new THREE.MeshBasicMaterial({ color: 0xff9a3a }),
    helipad: std(0x2e3238),
    helipadMark: new THREE.MeshBasicMaterial({ color: 0xf4f4f2 }),
    silhouette: std(0xf3eadb),
    /** Party lights: emissive so they read at night with no light of their own. */
    bulb: new THREE.MeshBasicMaterial({ color: 0xffd98a }),
    neonA: new THREE.MeshBasicMaterial({ color: 0xff3fa4 }),
    neonB: new THREE.MeshBasicMaterial({ color: 0x3fe0ff }),
  };
}

export function mats() { return (cache ??= build()); }
export type EstateMats = ReturnType<typeof build>;

/** A box with its base (not its centre) at `y`. */
export function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

export function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 8): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  return mesh;
}

/** A canvas sign: navy board, gold border, white lines with the second in gold (the same look as
 * the dock trophy's sign in entities/land/dock-celebration.ts). Material owns its texture. */
export function signMesh(lines: Array<[string, string]>, w: number, h: number, aspect = 2): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512; c.height = Math.round(512 / aspect);
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d2a44'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#f4c542'; g.lineWidth = 10; g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const step = (c.height - 40) / lines.length;
  lines.forEach(([font, text], i) => {
    g.font = font;
    g.fillStyle = i === 1 ? '#f4c542' : '#ffffff';
    g.fillText(text, c.width / 2, 20 + step * (i + 0.5), c.width - 40);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.userData.ownMat = true;
  return mesh;
}
