/**
 * A banner plane: a single-engine tail-dragger droning along the reef line at 120 m with a
 * forty-metre advertisement for a town business strung out behind it.
 *
 * This is a real and slightly absurd fixture of the Keys — somebody is always towing a banner up
 * US-1 — and it is the only thing in the game that advertises the town while you are out on the
 * water. The town is otherwise something you have to already know about to visit.
 *
 * ## The banner copy is the venues' own
 *
 * Each ad is `Venue.banner` (content/venues.ts), so the sky can never advertise a shop that does
 * not exist or sell something that was delisted. A banner slogan is its own field rather than a
 * slice of `tagline` for a reason recorded there: taglines are three bullet-separated clauses and
 * turn to mush at banner size.
 *
 * ## Why the letters are geometry, not a texture
 *
 * The obvious build is one long quad with a canvas texture. Rejected after trying it: a banner is
 * read almost edge-on most of the time, and a 40 m quad needs a ~4096 px strip to stay legible as
 * it turns toward you, which is a megabyte of texture per slogan and fourteen slogans. Instead
 * each letter is a small quad carrying one glyph from ONE shared 512 px atlas drawn at boot, and
 * the letters ride the same travelling wave as the banner cloth, so the text ripples with it.
 * Fourteen slogans cost one texture and one draw call.
 *
 * ## Cost
 *
 * One plane: 2 draw calls (airframe batch + the banner's letter batch). It exists only while one
 * is actually flying — between passes the whole group is removed from the scene, not just hidden,
 * so an idle sky costs nothing at all.
 */
import * as THREE from 'three';
import { VENUES, type VenueId } from '@keysrun/shared/content/venues';
import { landH } from '@keysrun/shared/world/depth';
import { rand } from '../../core/math.js';

/** Metres. A banner plane works low and slow — that is the whole point of the job. */
const ALTITUDE_MIN = 95, ALTITUDE_MAX = 150;
/** m/s. ~55 kn: a Cub towing forty metres of canvas is not going anywhere quickly. */
const SPEED_MIN = 26, SPEED_MAX = 32;
/** How far out a pass starts and ends. Long enough that it arrives and leaves rather than popping. */
const RUN_RADIUS = 1500;
/** Seconds between passes. Frequent enough to be a feature, rare enough to stay a treat. */
const GAP_MIN = 95, GAP_MAX = 240;
/** Letter cell on the atlas, and how tall a letter is in metres on the banner. */
const GLYPH_PX = 64, LETTER_H = 5.2, LETTER_W = 3.6;
/** The banner's cloth: how far behind the tail it starts, and the gap between letters. */
const TOW_GAP = 14, LETTER_GAP = 3.1;

const ATLAS_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&-· ';

/**
 * One 512 px atlas of white glyphs on transparent, drawn once at boot and shared by every
 * slogan. 8 columns of 64 px cells covers the alphabet, digits and the three punctuation marks
 * the copy uses.
 */
function glyphAtlas(): { tex: THREE.CanvasTexture; index: Map<string, number>; cols: number; rows: number } {
  const cols = 8, rows = Math.ceil(ATLAS_CHARS.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * GLYPH_PX; c.height = rows * GLYPH_PX;
  const g = c.getContext('2d')!;
  g.font = `700 ${Math.round(GLYPH_PX * 0.78)}px "Big Shoulders Display", Impact, "Arial Narrow", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  const index = new Map<string, number>();
  for (let i = 0; i < ATLAS_CHARS.length; i++) {
    const ch = ATLAS_CHARS[i];
    index.set(ch, i);
    if (ch === ' ') continue;
    g.fillText(ch, (i % cols) * GLYPH_PX + GLYPH_PX / 2, Math.floor(i / cols) * GLYPH_PX + GLYPH_PX * 0.54);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, index, cols, rows };
}

/** Letters the atlas has no cell for become a space rather than a tofu box. */
const sanitise = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9&\-· ]/g, ' ').replace(/\s+/g, ' ').trim();

interface Pass {
  /** Where the run starts, its heading, and how fast. */
  x: number; z: number; h: number; sp: number; alt: number;
  /** Distance flown along the run so far, metres. */
  flown: number;
  /** Total run length. */
  len: number;
  venue: VenueId;
  /** Letters of this slogan, in order; each is an instance index into the letter mesh. */
  text: string;
}

export interface BannerPlanes {
  group: THREE.Group;
  update(dt: number, t: number, boat: { x: number; z: number }, camera: { x: number; z: number }): void;
  /** VERIFICATION ONLY: the pass in progress, or null between passes. */
  debug(): { venue: string; text: string; x: number; z: number; alt: number; progress: number; tailX: number; tailZ: number } | null;
  /** VERIFICATION ONLY: start a pass now, optionally for a named venue, close enough to see. */
  debugFlyBy(boat: { x: number; z: number }, venue?: VenueId): void;
  dispose(): void;
}

/** The airframe: a high-wing tail-dragger, built nose-down -Z like everything else that flies here. */
function buildPlane(): { group: THREE.Group; geo: THREE.BufferGeometry[]; mats: THREE.Material[] } {
  const group = new THREE.Group();
  const geo: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const body = new THREE.MeshStandardMaterial({ color: 0xf2e9d8, roughness: 0.6, metalness: 0.1 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xc23a3a, roughness: 0.55, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7 });
  mats.push(body, trim, dark);
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void => {
    geo.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z); mesh.rotation.set(rx, ry, rz);
    group.add(mesh);
  };
  // fuselage, tapering to the tail
  add(new THREE.CylinderGeometry(0.55, 0.3, 7.2, 10), body, 0, 0, 0.4, Math.PI / 2);
  // nose cowl + spinner
  add(new THREE.CylinderGeometry(0.6, 0.55, 1.0, 10), trim, 0, 0, -3.4, Math.PI / 2);
  add(new THREE.ConeGeometry(0.28, 0.6, 8), trim, 0, 0, -4.1, -Math.PI / 2);
  // high wing, with struts
  add(new THREE.BoxGeometry(11.8, 0.16, 1.7), body, 0, 0.72, -0.6);
  add(new THREE.BoxGeometry(11.8, 0.05, 0.35), trim, 0, 0.64, -1.35);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.1, 1.0, 0.1), dark, sx * 2.1, 0.2, -0.3, 0, 0, sx * 0.32);
  // tailplane and fin
  add(new THREE.BoxGeometry(4.0, 0.12, 1.1), body, 0, 0.1, 3.5);
  add(new THREE.BoxGeometry(0.12, 1.5, 1.3), trim, 0, 0.75, 3.6);
  // undercarriage: two legs, two wheels, a tailwheel
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.1, 0.9, 0.1), dark, sx * 0.85, -0.65, -1.2, 0, 0, sx * 0.3);
    add(new THREE.CylinderGeometry(0.34, 0.34, 0.18, 10), dark, sx * 1.05, -1.1, -1.2, 0, 0, Math.PI / 2);
  }
  add(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 8), dark, 0, -0.42, 3.6, 0, 0, Math.PI / 2);
  // the propeller disc: a thin translucent ring is what a turning prop actually looks like
  const disc = new THREE.RingGeometry(0.25, 1.75, 20);
  geo.push(disc);
  const discMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false });
  mats.push(discMat);
  const d = new THREE.Mesh(disc, discMat);
  d.position.set(0, 0, -4.4);
  group.add(d);
  return { group, geo, mats };
}

export function createBannerPlanes(scene: THREE.Scene): BannerPlanes {
  const group = new THREE.Group();
  group.name = 'bannerPlane';
  group.visible = false;

  const plane = buildPlane();
  group.add(plane.group);

  const atlas = glyphAtlas();
  // One instanced quad per letter slot. 44 is the longest slogan plus headroom; a slogan shorter
  // than that simply parks its spare instances at zero scale.
  const MAX_LETTERS = 44;
  const letterGeo = new THREE.PlaneGeometry(LETTER_W, LETTER_H);
  // `depthTest: false` + a high render order so the letters always sit ON the cloth, from either
  // side, without a per-side offset that would bury them when the banner turns over. Nothing else
  // is ever between the camera and a banner at 120 m, so there is nothing for them to punch
  // through incorrectly.
  const letterMat = new THREE.MeshBasicMaterial({ map: atlas.tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  const letters = new THREE.InstancedMesh(letterGeo, letterMat, MAX_LETTERS);
  letters.frustumCulled = false;
  letters.renderOrder = 6;
  letters.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Per-instance atlas cell. The shader picks the cell by offsetting the quad's own uv, which is
  // why one material and one draw call can show forty different glyphs.
  const cell = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LETTERS * 2), 2);
  letterGeo.setAttribute('iCell', cell);
  letterMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 iCell;\nvarying vec2 vCell;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = iCell;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCell;')
      .replace('#include <map_fragment>', `
        vec2 cellUv = (vMapUv + vCell) / vec2(${atlas.cols.toFixed(1)}, ${atlas.rows.toFixed(1)});
        vec4 sampledDiffuseColor = texture2D(map, cellUv);
        diffuseColor *= sampledDiffuseColor;
      `);
  };
  group.add(letters);

  // The cloth the letters are pinned to.
  //
  // Six rows rather than two, at the heights in `ROW_Y`, so one strip can carry a sewn WHITE HEM
  // along each edge without a second mesh: the outer pair of rows is white, the inner pair red,
  // and the 2% gap between them makes the join crisp rather than a gradient across the whole
  // banner. A plain red rectangle read as a slab of card; the hem is most of what makes it look
  // like cloth somebody stitched.
  const CLOTH_SEGS = 56;
  const ROW_Y = [1.0, 0.84, 0.82, -0.82, -0.84, -1.0];
  const ROW_WHITE = [true, true, false, false, true, true];
  const CLOTH_HALF_H = LETTER_H * 0.78;
  const clothGeo = new THREE.PlaneGeometry(1, 1, CLOTH_SEGS, ROW_Y.length - 1);
  // Opaque on purpose. Transparent, it sorted against the equally-transparent letters that sit in
  // exactly the same plane, and three's painter sort has no stable answer at identical depth —
  // the cloth won about half the time and the slogan came out as dark smudges.
  const clothMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88, side: THREE.DoubleSide });
  {
    const col = new Float32Array(clothGeo.attributes.position.count * 3);
    const red = new THREE.Color(0xd92d1b), white = new THREE.Color(0xf6f1e6);
    for (let r = 0; r < ROW_Y.length; r++) {
      const c = ROW_WHITE[r] ? white : red;
      for (let sg = 0; sg <= CLOTH_SEGS; sg++) {
        const vi = r * (CLOTH_SEGS + 1) + sg;
        col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b;
      }
    }
    clothGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const cloth = new THREE.Mesh(clothGeo, clothMat);
  cloth.frustumCulled = false;
  group.add(cloth);

  // The tow line, and the spar the cloth is laced to. A banner does not float along behind the
  // aeroplane on its own — without these the first captures had forty metres of canvas hanging in
  // clear air a dozen metres off the tail, which is the single thing that made it read as pasted
  // on rather than towed.
  const ropeGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 5);
  ropeGeo.translate(0, 0.5, 0); // pivot at one end, so it can be aimed and stretched
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.9 });
  const rope = new THREE.Mesh(ropeGeo, ropeMat);
  rope.frustumCulled = false;
  group.add(rope);
  const sparGeo = new THREE.CylinderGeometry(0.1, 0.1, CLOTH_HALF_H * 2.1, 6);
  const sparMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.5 });
  const spar = new THREE.Mesh(sparGeo, sparMat);
  spar.frustumCulled = false;
  group.add(spar);

  let pass: Pass | null = null;
  let gap = rand(12, 40); // the first one comes along reasonably soon
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3();
  const tmpS = new THREE.Vector3(1, 1, 1);
  const ZERO = new THREE.Vector3(0, 0, 0);
  const UP = new THREE.Vector3(0, 1, 0);

  const VENUE_IDS = Object.keys(VENUES) as VenueId[];

  function begin(boat: { x: number; z: number }, venue?: VenueId): void {
    const v = venue ?? VENUE_IDS[Math.floor(Math.random() * VENUE_IDS.length)];
    const text = sanitise(VENUES[v].banner);
    // A run that passes the boat rather than at it: start on one side, aim across, offset so the
    // player watches it go by instead of being buzzed.
    const bearing = Math.random() * Math.PI * 2;
    const offset = rand(180, 520) * (Math.random() < 0.5 ? -1 : 1);
    const h = bearing + Math.PI / 2;
    const sx = boat.x + Math.cos(bearing) * RUN_RADIUS - Math.sin(h) * offset;
    const sz = boat.z + Math.sin(bearing) * RUN_RADIUS - Math.cos(h) * offset;
    pass = {
      x: sx, z: sz, h, sp: rand(SPEED_MIN, SPEED_MAX), alt: rand(ALTITUDE_MIN, ALTITUDE_MAX),
      flown: 0, len: RUN_RADIUS * 2.2, venue: v, text: text.slice(0, MAX_LETTERS),
    };
    group.visible = true;
    scene.add(group);
  }

  function end(): void {
    pass = null;
    group.visible = false;
    scene.remove(group);
    gap = rand(GAP_MIN, GAP_MAX);
  }

  return {
    group,
    update(dt, t, boat, camera) {
      if (!pass) {
        gap -= dt;
        if (gap <= 0) begin(boat);
        return;
      }
      const P = pass;
      const fx = -Math.sin(P.h), fz = -Math.cos(P.h);
      P.x += fx * P.sp * dt; P.z += fz * P.sp * dt;
      P.flown += P.sp * dt;
      if (P.flown > P.len) { end(); return; }

      // A banner tow is a hand-flown slog: it wanders a little and never sits still.
      const bank = Math.sin(t * 0.21 + P.alt) * 0.09;
      const y = P.alt + Math.sin(t * 0.17 + P.x * 0.001) * 2.2;
      plane.group.position.set(P.x, y, P.z);
      plane.group.rotation.set(0, P.h, bank, 'YXZ');

      // The banner streams straight back from the tail, sagging and rippling. The wave travels
      // backwards along it so the cloth looks dragged rather than wagged.
      const bx = -fx, bz = -fz; // backwards along the run
      const letterCount = Math.min(P.text.length, MAX_LETTERS);
      const span = TOW_GAP + letterCount * LETTER_GAP;

      // Which way round the letters face.
      //
      // A real banner reads correctly from ONE side and mirrored from the other, and the pilot
      // turns the good side to the crowd. A game cannot: the player is wherever they are, and a
      // slogan that comes out backwards on half the passes reads as a bug rather than as
      // authenticity (the first capture of this said "GARD RUOY NAHT RESOOL"). So the banner
      // presents its good side to the viewer — the letters flip as a block when the camera
      // crosses the plane of the cloth, which is exactly the moment the text is edge-on and the
      // flip cannot be seen.
      const midX = P.x + bx * (span / 2), midZ = P.z + bz * (span / 2);
      const nx = Math.cos(P.h), nz = -Math.sin(P.h);
      const facing = (camera.x - midX) * nx + (camera.z - midZ) * nz >= 0 ? 1 : -1;

      /**
       * What the wind is doing to the cloth at `back` metres behind the plane.
       *
       * Everything that rides the banner — the cloth rows, every letter, the spar — reads this
       * one function, so they move as one piece of fabric instead of three things that happen to
       * share a sine.
       *
       * Two things make it read as cloth rather than a ribbon on a stick:
       *
       *  - an ENVELOPE. The leading edge is laced to a rigid spar and cannot move, so amplitude
       *    is zero there and grows toward the free end. Without it the whole banner flapped in
       *    lockstep including the end bolted to the aeroplane, which is the thing that made it
       *    look like a rigid slab being waggled.
       *  - TWIST. A real banner rolls about its own long axis as the wave passes, so the top edge
       *    leads the bottom and you catch the back of it. One vertical offset shared by both
       *    edges can only ever be a ribbon seen edge-on.
       *
       * Two frequencies, deliberately not harmonically related, so the loop never lands on an
       * obvious beat over a pass that lasts a couple of minutes.
       */
      const wave = (back: number): { sag: number; twist: number } => {
        const f = Math.min(1, Math.max(0, (back - TOW_GAP) / Math.max(1, span - TOW_GAP)));
        const env = f * f;                       // nailed at the spar, loosest at the tail
        const a = t * 2.05 - back * 0.21;
        const b = t * 1.27 - back * 0.13;
        return {
          sag: -0.4 - f * 1.9 + (Math.sin(a) * 0.9 + Math.sin(b) * 0.5) * env,
          twist: (Math.sin(a + 0.6) * 0.42 + Math.sin(b * 1.4) * 0.2) * env,
        };
      };
      for (let i = 0; i < MAX_LETTERS; i++) {
        // Which character this physical slot carries. Slot 0 is nearest the plane; whether that
        // end is the viewer's LEFT or RIGHT depends on which side of the banner they are on, so
        // the order reverses with the facing. Without this the glyphs come out the right way
        // round and the slogan still reads backwards — "GARD RUOY NAHT RESOOL".
        const ch = i < letterCount ? P.text[facing === 1 ? letterCount - 1 - i : i] : ' ';
        if (i >= letterCount || ch === ' ') { tmpM.compose(tmpP.set(0, 0, 0), tmpQ.identity(), ZERO); letters.setMatrixAt(i, tmpM); continue; }
        const back = TOW_GAP + i * LETTER_GAP;
        const w = wave(back);
        const yaw = P.h + w.twist * 0.12;
        tmpP.set(P.x + bx * back, y + w.sag, P.z + bz * back);
        // `+ facing * PI/2`, not minus: a quad yawed by h + PI/2 has its front pointing along
        // (cos h, 0, -sin h), which is `n` below — so when the camera is on the +n side that is
        // the orientation that shows it the FRONT. Taking the other one shows the back face and
        // the slogan comes out mirrored, which is what the first two captures did.
        // The letter rolls with the cloth it is stitched to — `facing` flips the roll with the
        // side, or the text would lean the wrong way on half the passes.
        tmpQ.setFromEuler(new THREE.Euler(0, yaw + facing * (Math.PI / 2), -facing * w.twist, 'YXZ'));
        tmpM.compose(tmpP, tmpQ, tmpS);
        letters.setMatrixAt(i, tmpM);
        const idx = atlas.index.get(ch) ?? atlas.index.get(' ')!;
        // Row flipped: a CanvasTexture is uploaded with `flipY`, so canvas row 0 — the first row
        // of glyphs drawn — ends up at the TOP of UV space, not the bottom. Indexing rows the
        // way they were drawn samples the atlas upside down, which lands most letters on the
        // half-empty last row and renders them as blank slivers.
        cell.setXY(i, idx % atlas.cols, atlas.rows - 1 - Math.floor(idx / atlas.cols));
      }
      letters.instanceMatrix.needsUpdate = true;
      cell.needsUpdate = true;

      // The cloth. Each station gets a centre point on the wave and an UP vector rolled by the
      // twist, and the six rows hang off that — which is what lets the top and bottom edges
      // disagree and the banner show you its back as the wave goes down it.
      const clothPos = clothGeo.attributes.position as THREE.BufferAttribute;
      for (let sg = 0; sg <= CLOTH_SEGS; sg++) {
        const back = TOW_GAP + (sg / CLOTH_SEGS) * (span - TOW_GAP);
        const w = wave(back);
        const cxp = P.x + bx * back, cyp = y + w.sag, czp = P.z + bz * back;
        // up, rolled about the banner's own long axis: cos up the world Y, sin out along n
        const ux = Math.sin(w.twist) * nx, uy = Math.cos(w.twist), uz = Math.sin(w.twist) * nz;
        for (let r = 0; r < ROW_Y.length; r++) {
          const o = ROW_Y[r] * CLOTH_HALF_H;
          clothPos.setXYZ(r * (CLOTH_SEGS + 1) + sg, cxp + ux * o, cyp + uy * o, czp + uz * o);
        }
      }
      clothPos.needsUpdate = true;
      clothGeo.computeVertexNormals();

      // The spar at the leading edge, and the tow line back to the tail.
      const head = wave(TOW_GAP);
      const hx = P.x + bx * TOW_GAP, hy = y + head.sag, hz = P.z + bz * TOW_GAP;
      spar.position.set(hx, hy, hz);
      spar.rotation.set(0, P.h, head.twist, 'YXZ');
      const tailX = P.x - fx * 3.4, tailY = y - 0.35, tailZ = P.z - fz * 3.4;
      const rdx = hx - tailX, rdy = hy - tailY, rdz = hz - tailZ;
      const rlen = Math.hypot(rdx, rdy, rdz) || 1;
      rope.position.set(tailX, tailY, tailZ);
      rope.scale.set(1, rlen, 1);
      rope.quaternion.setFromUnitVectors(UP, tmpP.set(rdx / rlen, rdy / rlen, rdz / rlen));
    },
    debug() {
      if (!pass) return null;
      const fx = -Math.sin(pass.h), fz = -Math.cos(pass.h);
      const span = TOW_GAP + Math.min(pass.text.length, 44) * LETTER_GAP;
      return {
        venue: pass.venue, text: pass.text,
        x: +pass.x.toFixed(1), z: +pass.z.toFixed(1), alt: +pass.alt.toFixed(1),
        progress: +(pass.flown / pass.len).toFixed(3),
        // The far end of the banner — what a harness needs to frame the slogan broadside.
        tailX: +(pass.x - fx * span).toFixed(1), tailZ: +(pass.z - fz * span).toFixed(1),
      };
    },
    debugFlyBy(boat, venue) {
      if (pass) end();
      begin(boat, venue);
      // Put it alongside immediately rather than 1.5 km out, so a harness does not have to wait
      // the better part of a minute of simulated time for it to arrive.
      const P = pass!;
      const fx = -Math.sin(P.h), fz = -Math.cos(P.h);
      P.x = boat.x - fx * 240; P.z = boat.z - fz * 240;
      P.flown = P.len * 0.4;
      void landH;
    },
    dispose() {
      scene.remove(group);
      plane.geo.forEach((g) => g.dispose());
      plane.mats.forEach((m) => m.dispose());
      letterGeo.dispose(); letterMat.dispose();
      ropeGeo.dispose(); ropeMat.dispose(); sparGeo.dispose(); sparMat.dispose();
      clothGeo.dispose(); clothMat.dispose();
      atlas.tex.dispose();
    },
  };
}
