/**
 * The trolling spread: the lines actually in the water behind the boat, and the lures skipping
 * along on them.
 *
 * Trolling swung the riggers out and splashed when something ate, but between those two moments
 * nothing was being dragged — the mode was a timer with a sound. The spread is the part you
 * watch: four lines fanned astern, each with a lure riding the surface, popping in and out of the
 * face of the wake.
 *
 * Geometry, not simulation. Each lure holds station at a fixed distance and angle astern in the
 * boat's own frame, so the spread swings with the hull and trails properly through a turn
 * without needing its own physics. What varies is the ride: a lure skips, so it tracks the water
 * surface and lifts clear of it on a beat of its own, and the line slackens as the lure rises and
 * comes taut as it digs back in.
 *
 * The two long lines hang off the rigger tips (entities/boat/model.ts's `outriggerTips`) and the
 * two short ones straight off the transom, which is how a spread is actually set: the riggers
 * hold the outside baits wide of the wake, the flat lines run down the prop wash.
 */
import * as THREE from 'three';
import type { BoatModel } from '../../entities/boat/model.js';

/**
 * Lure stations, in the boat's own frame: metres astern, and metres to one side.
 *
 * These are real spread distances. A rigger bait goes back 150-250 ft and a shotgun further still
 * — the baits are spaced DOWN the wake, not clustered behind the transom, so each one is working
 * a different piece of water and they do not tangle through a turn. The first version had
 * everything inside 34 m, which put the whole spread in the white water and read as four lures
 * trailing off the back of the boat rather than a spread being fished.
 *
 * The shotgun is the long one straight down the middle, run from the tower on a real boat. It is
 * the bait that gets eaten when nothing else will, and at 96 m it is most of a football pitch
 * behind you.
 */
const STATIONS: ReadonlyArray<{ back: number; side: number; rigger: 0 | 1 | null }> = [
  { back: 64, side: -23, rigger: 0 },   // long rigger, port
  { back: 56, side: 21, rigger: 1 },    // long rigger, starboard
  { back: 38, side: -7.5, rigger: null },  // flat line, port
  { back: 45, side: 7.5, rigger: null },   // flat line, starboard
  { back: 96, side: 1.5, rigger: null },   // shotgun, way back down the middle
];

/** How long a lure stays hauled under after it is eaten, seconds. */
const PULL_S = 1.1;
/** How far under, metres. Deep enough to be gone, not so deep the line looks snagged. */
const PULL_DEPTH = 1.5;

/** Points down each line. More than before because the lines are now two to three times as long
 * and a 10-segment catenary across 96 m is a visible run of straight sticks. */
const SEG = 16;

export interface TrollSpread {
  group: THREE.Group;
  /** How many lures are in the water. A strike picks one of these to come up on. */
  readonly count: number;
  /**
   * World position of lure `i` as of the last `update`, written into `out`. False if the spread
   * is stowed or `i` is not a station, in which case `out` is untouched.
   *
   * This exists so a fish can be raised on a lure the player can actually see rather than at an
   * invented point astern: game/fishing/troll-raise.ts tracks whichever station is being worked,
   * and the lure keeps skipping and swinging through the turn while the fish climbs to it.
   */
  lurePos(i: number, out: THREE.Vector3): boolean;
  /**
   * Yank lure `i` under for `secs`. A fish does not nibble a trolled lure: it eats it going the
   * other way at speed, and the first thing anyone on the boat sees is the bait vanish and the
   * line come up tight. Without this the lure went on skipping merrily while the fish that had
   * just swallowed it jumped behind it.
   */
  sound(i: number, secs?: number): void;
  /**
   * `out` is how far the spread is deployed, 0..1 — the same number the riggers swing on, so
   * the lines come out with the poles instead of appearing fully set.
   * `sample(x, z)` is the water height there.
   */
  update(t: number, model: BoatModel, out: number, sample: (x: number, z: number) => number): void;
}

export function createTrollSpread(scene: THREE.Scene): TrollSpread {
  const group = new THREE.Group();
  group.name = 'trollSpread';
  group.visible = false;
  scene.add(group);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xe8eef2, transparent: true, opacity: 0.55 });
  const lures: THREE.Mesh[] = [];
  const lines: THREE.Line[] = [];
  const skirtMat = new THREE.MeshStandardMaterial({ color: 0xe04a2a, roughness: 0.45, metalness: 0.25 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.3, metalness: 0.7 });

  for (let i = 0; i < STATIONS.length; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const line = new THREE.Line(geo, lineMat);
    line.frustumCulled = false;
    group.add(line);
    lines.push(line);

    // A skirted trolling lure: a weighted head with a skirt streaming off it.
    const lure = new THREE.Group() as unknown as THREE.Mesh;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.22, 8), headMat);
    head.rotation.x = Math.PI / 2;
    lure.add(head);
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 8, 1, true), skirtMat);
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.z = 0.24;
    lure.add(skirt);
    group.add(lure);
    lures.push(lure);
  }

  const _tip = new THREE.Vector3(), _lure = new THREE.Vector3(), _p = new THREE.Vector3();

  /** Per-station "dragged under" timer, seconds remaining. */
  const pulled = new Float32Array(STATIONS.length);
  let lastT = 0;

  /**
   * The boat's recent track, so the baits can TRAIL rather than pivot.
   *
   * Stations used to be resolved in the boat's current frame, which meant the whole spread
   * rotated rigidly about the hull the instant it turned — a lure 96 m astern swung through a
   * 96 m arc in one frame, as if it were on the end of a boom. A trolled bait does nothing of
   * the kind: it is dragged along the water the boat has already been through, so in a turn the
   * spread strings out along the wake and falls inside the curve, and only straightens once the
   * boat does.
   *
   * Stored by DISTANCE rather than by time: what decides where a bait sits is how much line is
   * out, not how long ago. One sample every `TRACK_STEP_M`, enough of them to cover the longest
   * station with room to spare.
   */
  const TRACK_STEP_M = 0.6;
  const TRACK_LEN = Math.ceil((STATIONS[STATIONS.length - 1].back + 24) / TRACK_STEP_M);
  const trkX = new Float64Array(TRACK_LEN), trkZ = new Float64Array(TRACK_LEN), trkH = new Float64Array(TRACK_LEN);
  /** Index of the newest sample, and how many are valid. */
  let trkHead = -1, trkCount = 0;

  function pushTrack(x: number, z: number, h: number): void {
    if (trkHead < 0) { trkHead = 0; trkX[0] = x; trkZ[0] = z; trkH[0] = h; trkCount = 1; return; }
    const d = Math.hypot(x - trkX[trkHead], z - trkZ[trkHead]);
    // A jump means a teleport (the debug hooks, a respawn) rather than a boat; start the track
    // again or the spread spends the next 160 m dragging itself across the map.
    if (d > 24) { trkHead = 0; trkX[0] = x; trkZ[0] = z; trkH[0] = h; trkCount = 1; return; }
    if (d < TRACK_STEP_M) return;
    const n = Math.min(8, Math.floor(d / TRACK_STEP_M));
    for (let k = 1; k <= n; k++) {
      const f = k / n, px = trkX[trkHead], pz = trkZ[trkHead], ph = trkH[trkHead];
      trkHead = (trkHead + 1) % TRACK_LEN;
      trkX[trkHead] = px + (x - px) * f;
      trkZ[trkHead] = pz + (z - pz) * f;
      // Shortest-way heading interpolation, or a boat crossing north spins its whole spread.
      let dh = ((h - ph + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      trkH[trkHead] = ph + dh * f;
      trkCount = Math.min(TRACK_LEN, trkCount + 1);
    }
  }

  /**
   * The point on the track `back` metres behind the boat, and the heading there. Null until
   * enough track has been laid — on the first seconds of a set the caller falls back to the
   * boat's own frame, which is right anyway because the gear is still going out.
   */
  function trackBack(back: number): { x: number; z: number; h: number } | null {
    if (trkCount < 3) return null;
    let acc = 0;
    for (let k = 0; k < trkCount - 1; k++) {
      const i = (trkHead - k + TRACK_LEN * 2) % TRACK_LEN;
      const j = (i - 1 + TRACK_LEN) % TRACK_LEN;
      const seg = Math.hypot(trkX[i] - trkX[j], trkZ[i] - trkZ[j]);
      if (acc + seg >= back) {
        const f = seg > 1e-6 ? (back - acc) / seg : 0;
        let dh = ((trkH[j] - trkH[i] + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        return { x: trkX[i] + (trkX[j] - trkX[i]) * f, z: trkZ[i] + (trkZ[j] - trkZ[i]) * f, h: trkH[i] + dh * f };
      }
      acc += seg;
    }
    return null; // not enough track yet for a station this far back
  }

  function update(t: number, model: BoatModel, out: number, sample: (x: number, z: number) => number): void {
    // Drive the yank timers off the clock the caller already passes, so this needs no dt of its
    // own and stays in step with the ride above.
    const dt = Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    for (let i = 0; i < pulled.length; i++) if (pulled[i] > 0) pulled[i] = Math.max(0, pulled[i] - dt);

    group.visible = out > 0.02;
    if (!group.visible) return;

    model.group.updateMatrixWorld(true);
    const h = model.group.rotation.y;
    // Boat frame: forward is (-sin h, -cos h), so astern is the negation and starboard is across.
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const rx = Math.cos(h), rz = -Math.sin(h);
    const bx = model.group.position.x, bz = model.group.position.z;
    pushTrack(bx, bz, h);

    for (let i = 0; i < STATIONS.length; i++) {
      const st = STATIONS[i];
      // The spread opens as the gear goes out rather than snapping to full length.
      const back = st.back * out, side = st.side * out;
      // Where the water under this bait actually is: back along the boat's own track, offset
      // across the heading IT had there. Falls back to the current frame only while the track is
      // still being laid (a fresh set, or just after a teleport).
      const tp = trackBack(back);
      // The bait's own frame: the heading of the track where it is sitting, not the hull's. In a
      // turn these differ by most of the turn, which is the whole point.
      const lh = tp ? tp.h : h;
      const lrx = Math.cos(lh), lrz = -Math.sin(lh);
      let lx: number, lz: number;
      if (tp) {
        lx = tp.x + lrx * side;
        lz = tp.z + lrz * side;
      } else {
        lx = bx - fx * back + rx * side;
        lz = bz - fz * back + rz * side;
      }
      const water = sample(lx, lz);

      // The skip. A lure does not sit on the surface, it porpoises: mostly in the face of a wave
      // and clear of it for a moment each beat. Each station gets its own beat so they do not
      // pop in unison, which would read as one object repeated.
      const beat = Math.sin(t * (3.1 + i * 0.37) + i * 1.9);
      const air = Math.max(0, beat) ** 2;
      // Eaten: hauled down hard and held there, easing back up as the fish settles onto the
      // hook. Deepest right at the strike, which is when it is being taken away from you.
      const yank = pulled[i] > 0 ? Math.min(1, pulled[i] / PULL_S) : 0;
      const ly = water + 0.06 + air * 0.5 * (1 - yank) - yank * PULL_DEPTH;

      // The SWIM. A skirted lure does not track straight — the whole point of the angled,
      // weighted head is that it digs in, darts off to one side, rolls over, breaks the surface
      // and falls back in. Without it these were four beads being towed in a straight line.
      //
      // It is a weave ACROSS the line of travel, strongest while the lure is in the water and
      // dying out while it is in the air (nothing to bite on), with the nose leading the weave by
      // a quarter cycle the way a thing that is actually swimming turns before it moves. Each
      // station has its own frequency, so the spread never falls into step with itself.
      const swimF = 2.15 + i * 0.43;
      const swimPh = t * swimF + i * 2.3;
      const bite = 1 - air * 0.75;                       // digging in, not skipping clear
      const swim = Math.sin(swimPh) * 0.52 * bite;       // metres off the straight line
      const wag = Math.cos(swimPh) * 0.42 * bite;        // radians of nose swing, leading it

      _lure.set(lx + lrx * swim, ly, lz + lrz * swim);
      lures[i].position.copy(_lure);
      // Nose down ITS line of travel and across the weave, rolling as it digs and comes out.
      lures[i].rotation.set(-0.3 + air * 0.6, lh + wag, Math.sin(t * 2.3 + i) * 0.25 + wag * 0.55, 'YXZ');

      // Where the line leaves the boat.
      if (st.rigger !== null && model.outriggerTips[st.rigger]) {
        model.outriggerTips[st.rigger].getWorldPosition(_tip);
      } else {
        _tip.set(bx - fx * 1.2 + rx * st.side * 0.22, model.group.position.y + 1.5, bz - fz * 1.2 + rz * st.side * 0.22);
      }

      // Slack follows the ride: taut while the lure is digging, bowed while it is in the air —
      // and scaled by how much line is out, since a 96 m shotgun line carries a far bigger belly
      // than a 38 m flat line at the same tension.
      const slack = (0.1 + air * 0.5) * (0.55 + back / 60);
      const pos = lines[i].geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let s = 0; s <= SEG; s++) {
        const u = s / SEG;
        _p.lerpVectors(_tip, _lure, u);
        // Catenary-ish bow, pinned at both ends, never dipping below the water it rides on.
        const sag = Math.sin(Math.PI * u) * slack;
        _p.y = Math.max(sample(_p.x, _p.z) - 0.02, _p.y - sag);
        pos.setXYZ(s, _p.x, _p.y, _p.z);
      }
      pos.needsUpdate = true;
      lines[i].geometry.computeBoundingSphere();
    }
  }

  function sound(i: number, secs = PULL_S): void {
    if (i >= 0 && i < pulled.length) pulled[i] = secs;
  }

  function lurePos(i: number, out: THREE.Vector3): boolean {
    if (!group.visible || i < 0 || i >= lures.length) return false;
    out.copy(lures[i].position);
    return true;
  }

  return { group, count: STATIONS.length, lurePos, sound, update };
}
