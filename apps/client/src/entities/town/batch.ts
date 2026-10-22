/**
 * `GeoBatch`: build a whole street's worth of boxes, posts and wedges into ONE vertex-coloured
 * BufferGeometry.
 *
 * Why not a `THREE.Mesh` per bench, palm and kerb: the town is a few thousand primitives, and a
 * draw call per primitive would make walking past a bar cost more than the entire boat. Merged by
 * material it is a handful of draws regardless of how many lamp posts a later pass adds. Colour
 * rides in the vertex attribute, so one `MeshStandardMaterial({ vertexColors: true })` covers every
 * wall, car and awning stripe.
 *
 * Written against raw arrays instead of `BufferGeometryUtils.mergeGeometries`: that helper wants
 * one `BufferGeometry` per primitive up front, which for ~4,000 boxes is 4,000 allocations just to
 * be thrown away. Here a primitive is a template (24 verts, 36 indices) transformed straight into
 * the output arrays.
 */
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Matrix3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();

export interface Xform { ry?: number; rx?: number; rz?: number }

export class GeoBatch {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  /**
   * `withUV`: include UVs (for glow quads that sample a radial texture). Costs nothing otherwise.
   *
   * `lift`: baked shade compensation, multiplied into the vertex colours. 'street' is for the
   * outdoor town: its whole frontage faces SOUTH (the harbour) while the day sun sits low in the
   * NE, so every facade is in permanent shade lit only by the hemisphere term. Measured on the
   * first captures: a dim, teal-grey town. A flat emissive lift was tried and rejected — it adds
   * the same grey to every colour and desaturates the dark ones (the bar's wood panelling went
   * grey) — so instead faces that the day sun cannot reach (south, and to a lesser degree west
   * in the local frame) have their albedo raised, which scales with the light actually falling
   * on them. A number is a uniform multiplier, for interiors, which no sun ever reaches.
   */
  constructor(private readonly withUV = false, private readonly lift: number | 'street' = 1) {}

  get triangleCount(): number { return this.idx.length / 3; }

  private push(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number): void {
    const p = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const base = this.pos.length / 3;
    _n.getNormalMatrix(m);
    _c.setHex(color);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(nrm, i).applyMatrix3(_n).normalize();
      this.nor.push(_v.x, _v.y, _v.z);
      const k = this.lift === 'street' ? 1 + 0.5 * Math.max(0, _v.z) + 0.3 * Math.max(0, -_v.x) + 0.18 * (1 - Math.min(1, Math.abs(_v.y) * 1.6)) : this.lift;
      this.col.push(_c.r * k, _c.g * k, _c.b * k);
      if (this.withUV) this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const ix = g.index!;
    for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
  }

  private mat(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, t?: Xform): THREE.Matrix4 {
    _e.set(t?.rx ?? 0, t?.ry ?? 0, t?.rz ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    return _m.compose(_p.set(cx, cy, cz), _q, _s.set(sx, sy, sz));
  }

  /** A box centred at (cx,cy,cz) with full extents (w,h,d). */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, color: number, t?: Xform): this {
    this.push(UNIT_BOX, this.mat(cx, cy, cz, w, h, d, t), color);
    return this;
  }

  /** An axis-aligned box from two corners — the natural form for walls and slabs. */
  span(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number): this {
    return this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), color);
  }

  /** A vertical cylinder (or cone, rTop 0) standing on y0. */
  cyl(cx: number, y0: number, cz: number, rTop: number, rBot: number, h: number, color: number, seg = 8, t?: Xform): this {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    this.push(g, this.mat(cx, y0 + h / 2, cz, 1, 1, 1, t), color);
    g.dispose();
    return this;
  }

  /** A sphere (palm crowns, bushes, bulbs). */
  ball(cx: number, cy: number, cz: number, r: number, color: number, sy = 1, seg = 8): this {
    const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2));
    this.push(g, this.mat(cx, cy, cz, 1, sy, 1), color);
    g.dispose();
    return this;
  }

  /** A triangular prism: a gable roof over a w x d footprint, ridge along z (or x if `alongX`). */
  gable(cx: number, y0: number, cz: number, w: number, d: number, rise: number, color: number, alongX = false): this {
    const hw = (alongX ? d : w) / 2, hd = (alongX ? w : d) / 2;
    const sh = new THREE.Shape([new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0), new THREE.Vector2(0, rise)]);
    const g = new THREE.ExtrudeGeometry(sh, { depth: hd * 2, bevelEnabled: false });
    g.translate(0, 0, -hd);
    g.computeVertexNormals();
    const t = new THREE.Matrix4().makeRotationY(alongX ? Math.PI / 2 : 0).setPosition(cx, y0, cz);
    // ExtrudeGeometry is non-indexed; give it a trivial index so `push` can treat it like the rest
    if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    this.push(g, t, color);
    g.dispose();
    return this;
  }

  /**
   * A flat quad (for glow pools and halos): centre, then two half-extent axes. UVs run 0..1 so a
   * radial-gradient texture lands as a soft disc.
   */
  quad(cx: number, cy: number, cz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number): this {
    const base = this.pos.length / 3;
    _c.setHex(color);
    _v.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx).normalize();
    const c: Array<[number, number, number, number, number]> = [
      [-1, -1, 0, 0, 0], [1, -1, 0, 1, 0], [1, 1, 0, 1, 1], [-1, 1, 0, 0, 1],
    ];
    for (const [s, t, , u, v] of c) {
      this.pos.push(cx + ax * s + bx * t, cy + ay * s + by * t, cz + az * s + bz * t);
      this.nor.push(_v.x, _v.y, _v.z);
      this.col.push(_c.r, _c.g, _c.b);
      if (this.withUV) this.uv.push(u, v);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
    return this;
  }

  /** Horizontal soft disc on the ground (a lamp's pool of light). */
  pool(cx: number, y: number, cz: number, r: number, color: number): this {
    return this.quad(cx, y, cz, r, 0, 0, 0, 0, r, color);
  }

  /** Two crossed vertical quads: a cheap omnidirectional halo around a bulb or neon head. */
  halo(cx: number, cy: number, cz: number, r: number, color: number): this {
    this.quad(cx, cy, cz, r, 0, 0, 0, r, 0, color);
    this.quad(cx, cy, cz, 0, 0, r, 0, r, 0, color);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx.length > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
