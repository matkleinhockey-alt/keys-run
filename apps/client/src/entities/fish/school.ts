/**
 * `stepSchool(state, ctx)` — the pure simulation half of legacy `updateCreatures`
 * (index.html:2541-2600), restructured per docs/ARCHITECTURE.md's fish-ownership note: this file
 * touches no three.js and no DOM, only `SchoolState` (types.ts) and plain numbers, so a later
 * phase can lift it onto the server (docs/ARCHITECTURE.md phase 4/5, "fish tiering, resident
 * schools") by importing this module from `apps/sim` instead of rewriting it. `render.ts` is the
 * other half — it reads the `wx/wy/wz/yaw/pitch/roll` this file writes onto each member and turns
 * them into `InstancedMesh` matrices.
 *
 * Deliberately mutates `state` in place and returns the same reference, rather than following
 * packages/shared's `step*(state,input,dt) -> new state` convention. docs/ARCHITECTURE.md's own
 * GC-discipline section calls tracked fish out by name as *the* case where the allocating,
 * functional form stops being "immaterial" ("tier-3 tracked fish at ~1,700 entities is 3,400
 * objects/tick, an order of magnitude worse [than boats]... do the in-place variant when fish
 * land") — fish are landing now, client-side, at potentially hundreds of members updated every
 * frame, so this starts in-place rather than allocating a fresh members array (and a fresh object
 * per member) 60 times a second only to switch later.
 *
 * Dropped from legacy on purpose (not "forgot to port"): the tuna/`F`-state strike branch
 * (index.html:2552-2555) and the per-act particle spray/splash calls. Both are rod-fishing
 * integration points — fishing is phase-3 scope and `F.state` is always `'idle'` in this phase
 * (see stubs.ts) and `game/fishing.ts` is out of this task's ownership, so porting the branch that
 * reads `F` would be dead code wired to nothing. Surface "acts" (tail-slaps, rolls, blows) still
 * run and still report their contact moment back to the caller as a `SchoolEvent` so a later
 * phase (or this one, optionally — see index.ts) can spawn a splash without school.ts needing to
 * know particles exist.
 */
import { depthAt, offshoreF, WB } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { chumPull, CARCASS_MILL_R } from '@keysrun/shared/sim/chum';
import { clamp, lerp, rand } from '../../core/math.js';
import { swimAngSpeed } from './swim.js';
import {
  angLerp, fleeClassFor, fleeParamsFor, nearestTrigger, ACT_DUR, ACT_CD,
  isBowRider, bowRideTarget, fleeHeadingFrom, BOW_RIDE_RADIUS, BOW_RIDE_MIN_SPEED, BOW_RIDE_MAX_SPEED,
} from './behavior.js';
import type { SchoolCtx, SchoolState, FishMember } from './types.js';
import { seaHAt } from '@keysrun/shared/sim/depth-grid';

/** Sea-floor world-Y for a depth — the identity (negation), matching `world/seafloor.ts`'s
 * `floorY`. 1 world unit = 1 metre, so a 34 m depth puts the floor at y = -34.
 *
 * ⚠ This was a *stale copy* of legacy's clamped formula, `-(0.25 + min(d,14) * 0.55)`, duplicated
 * here (rather than imported) to keep this module free of three.js, and then never updated when
 * seafloor.ts's own `floorY` became the identity. The clamp saturates at y ≈ -7.95 for any depth
 * past 14 m, so while the *terrain* rendered the real reef wall dropping to 34-45 m and the Gulf
 * Stream past 100 m, every fish school was still being placed against a floor 8 m down. Fish could
 * not exist below ~8 m anywhere in the world: depth bands 4 and 5 (15-20 m and 20 m+) were empty by
 * construction, and the deep-water species tables had nowhere to put anything.
 *
 * Kept as a named one-liner rather than inlining `-d` at both call sites so the relationship to
 * seafloor.ts's `floorY` stays greppable — but note that a duplicated constant is exactly what
 * caused this, so if either definition ever becomes non-trivial, move it into @keysrun/shared
 * (pure, no three.js) instead of copying it a third time. */
const floorY = (d: number): number => -d;

/** The seafloor/surface world-Y pair at a point — the same two numbers `stepMember` uses to place
 * every member's `y` (`level==='bottom'|'surface'|'mid'`, see below). Exported so a caller that
 * isn't stepping a school (verification tooling, a future camera/diver buoyancy query) can place
 * something in the water column without re-deriving the formula — see index.ts's `waterColumnAt`
 * and test/capture-fish-screenshots.mjs, which uses it to put a camera at fish-eye height instead
 * of guessing a world Y blind. */
export function waterColumnAt(x: number, z: number, t: number): { floor: number; surf: number } {
  const d = depthAt(x, z);
  return { floor: floorY(d), surf: seaHAt(x, z, t) };
}

export type SchoolEvent =
  | { type: 'splash'; x: number; z: number; r: number; p: number }
  /** A whale's blow/spout at the peak of its 'blow' act (school.ts's `stepMember`) — the visual
   * tell that sells a whale at distance (task brief). `index.ts` is the intended consumer (see
   * entities/fish/spout.ts): this module reports the moment/location, same split as 'splash'. */
  | { type: 'blow'; x: number; y: number; z: number };

/** legacy `updateCreatures`'s per-group block. `V` is the school's species spec (caller looks it
 * up once by `state.type` — kept out of `SchoolState` itself so the state stays plain/small, in
 * the spirit of the server-replication note in docs/ARCHITECTURE.md's netcode section:
 * "immutable descriptors ... sent once at spawn, never in snapshots"). */
/**
 * Bounds on the tail-beat rate multiplier, and the hardest a fish will lean into a turn.
 * BEAT_MIN is not 0: a fish holding station still sculls, and a frozen tail reads as a dead one.
 */
const BEAT_MIN = 0.45, BEAT_MAX = 2.4;
/**
 * How deep a `level: 'surface'` species actually cruises, in metres below the wave surface.
 *
 * They used to sit at a flat 0.5 m always, which put a school of tuna permanently on top of the
 * water whether it was feeding or not. A tuna works the top of the column, but it is not a
 * floating object: it comes up to feed and drops back down. This is the "down".
 */
const SURFACE_CRUISE_M = 3.4;

/** How long a school-wide surface frenzy runs, and how long between them. A frenzy should be
 * something you spot from a distance and run to, not the sea's resting state. */
const FRENZY_S: readonly [number, number] = [9, 18];
const FRENZY_CD_S: readonly [number, number] = [40, 110];
/** The last seconds of a frenzy are also the rise into it: the school eases up and back down
 * rather than teleporting to the top. */
const FRENZY_RISE_S = 3;

/** Where a mid-water species sits between the floor and the surface, 0 at the bottom. Nudged down
 * from 0.55 — everything in the column was riding a little high. */
const MID_LEVEL = 0.46;

/** rad — about 21 degrees. A banking fish, not a barrel roll. */
const BANK_MAX = 0.37;

/** How far a school will notice a motionless diver, metres. */
const CURIOUS_RANGE = 36;
/**
 * Diver speed (m/s) at which curiosity is gone. The diver is carried by the current even when not
 * kicking, so this cannot be a hair-trigger: a first attempt faded curiosity linearly to zero at
 * 0.5 m/s, and the measured drift of 0.3 m/s alone cut the effect to a sixth, leaving fish at
 * 10 m again. Full strength up to CURIOUS_FULL_SPEED, gone by here.
 */
const CURIOUS_MAX_SPEED = 0.75;
/** Below this the diver is holding station as far as a fish is concerned — drift included. */
const CURIOUS_FULL_SPEED = 0.35;
/** Hardest the patch leans toward a diver, 0..1 of the way there. Under 1 on purpose: a school
 * that fully adopted the diver as its anchor would follow them around the reef. */
const CURIOUS_PULL = 0.92;

export function stepSchool(state: SchoolState, V: CreatureVis, ctx: SchoolCtx): SchoolEvent[] {
  const { t, dt, threats } = ctx;
  const events: SchoolEvent[] = [];
  const g = state;

  // Bow-riding (dolphin schools only — behavior.ts's `isBowRider`): a moving boat within range
  // is noticed and ridden instead of fled from, so the boat threat is pulled out of the flee
  // trigger check below while riding (a pod shouldn't simultaneously bolt from the very boat
  // it's tucked up against the bow of).
  const boatThreat = isBowRider(V) ? threats.find((th) => th.kind === 'boat') : undefined;
  const canBowRide = !!boatThreat && boatThreat.heading !== undefined
    && Math.hypot(boatThreat.x - g.cx, boatThreat.z - g.cz) < BOW_RIDE_RADIUS
    && boatThreat.speed > BOW_RIDE_MIN_SPEED && boatThreat.speed < BOW_RIDE_MAX_SPEED;
  g.bowRide = lerp(g.bowRide, canBowRide ? 1 : 0, Math.min(1, dt * 0.6));
  const bowRiding = g.bowRide > 0.4 && !!boatThreat && boatThreat.heading !== undefined;
  const triggerThreats = bowRiding ? threats.filter((th) => th !== boatThreat) : threats;

  const heading0 = g.heading;
  const cls = fleeClassFor(g.type, V);
  const trigger = nearestTrigger(g.cx, g.cz, cls, triggerThreats);
  if (trigger) {
    if (g.flee <= 0 && V.act === 'glide' && !g.glide) g.glide = rand(1.6, 3.4);
    g.flee = 1.5;
    // AWAY from the trigger, not toward it. Heading's forward vector is (-sin h, -cos h), so
    // `atan2(-dx, -dz)` is the *toward* form — it is what bow-riding uses a few lines below to
    // close on the bow. Flee had the same expression, so a spooked school swam straight at
    // whatever spooked it, re-entered the trigger radius, re-triggered, and orbited the threat.
    // Under a stopped boat that is a ring of fish lapping the hull about once a second (measured:
    // 257 turns in four simulated minutes, identical at every anchor radius — which is what gave
    // it away as the flee path rather than the anchor).
    g.fleeHeading = fleeHeadingFrom(g.cx, g.cz, trigger);
  }
  if (V.act === 'glide' && !g.glide && Math.random() < dt * 0.03) g.glide = rand(1.6, 3.4);

  // School-wide feeding frenzy, for the species that bust. Runs on its own clock rather than
  // per member, so the whole school comes up together, works the surface for a few seconds and
  // drops back down — which is what a frenzy looks like, and what makes one worth running to.
  // A spooked school does not feed.
  if (V.act === 'bust') {
    if (g.frenzy > 0) {
      g.frenzy -= dt;
      if (g.frenzy <= 0) g.frenzyTimer = rand(FRENZY_CD_S[0], FRENZY_CD_S[1]);
    } else {
      g.frenzyTimer -= dt;
      if (g.frenzyTimer <= 0) {
        if (g.flee > 0) g.frenzyTimer = rand(4, 10);
        else g.frenzy = rand(FRENZY_S[0], FRENZY_S[1]);
      }
    }
  }

  let sp = V.speed;
  if (bowRiding && boatThreat && boatThreat.heading !== undefined) {
    // Pick a side deterministically per school (so several simultaneous pods spread across both
    // sides of the bow instead of stacking) and steer the centroid toward the pressure-wave slot
    // just off that side — see behavior.ts's `bowRideTarget`. Member offsets (ox/oz, below) still
    // fan the pod out around this point, and the per-member 'porpoise' act keeps running
    // unmodified, so a riding pod still porpoises as it rides.
    const side = Math.sin(g.phase) >= 0 ? 1 : -1;
    const tgt = bowRideTarget(boatThreat.x, boatThreat.z, boatThreat.heading, side);
    const dx = tgt.x - g.cx, dz = tgt.z - g.cz;
    g.heading = angLerp(g.heading, Math.atan2(-dx, -dz), dt * 3.2);
    // keep pace with the boat (plus a little headroom to actually catch up/stay ahead) rather
    // than the species' own cruising speed
    sp = Math.max(boatThreat.speed * 1.05, 2.5);
  } else if (g.flee > 0) {
    g.flee -= dt;
    g.heading = angLerp(g.heading, g.fleeHeading, dt * 4);
    sp *= fleeParamsFor(cls).speedMul;
  } else {
    g.heading += (Math.sin(t * 0.37 + g.phase) * 0.35 + Math.sin(t * 0.11 + g.phase * 2) * 0.2) * dt;
  }

  // A resident school holds a patch (spawn.ts gives it a 6-16 m anchor). The obvious way to write
  // that is a tangential orbit with a radial correction toward radius R — which is what this did,
  // and it is wrong in a way that is invisible in code and glaring in play: the correction is a
  // stable attractor, so every school converges onto a perfect circle of radius R and stays there,
  // turning the same way forever. Parked over a bait frenzy watching one patch, it reads as fish
  // spinning in circles, because that is exactly what they are doing.
  //
  // Real fish holding structure mill: they wander over the patch, drift off the edge, and come
  // back. So the anchor is a soft tether rather than a track. Inside the patch nothing steers at
  // all — the wander above runs untouched. Only past the edge does a homing term fade in, and the
  // slight tangential lead that stops a school charging straight through the middle reverses on a
  // ~90 s cycle, so no school can settle into a fixed carousel even out at the boundary.
  //
  // A shot bird floating on the surface (sim/chum.ts) is leaned toward by exactly the same
  // mechanism, with the subject changed: `chumPull` hands back a point and a 0..1 weight, the same
  // pair the diver-curiosity block below produces, and the patch is lerped toward it. The obvious
  // alternative — point the centroid at the carcass and swim — is not used, because it gives you a
  // shark that tracks the bait like a torpedo, and what the scene wants is something that works
  // its way in on a long arc and then jostles over it. Milling is already what this block does
  // once the patch is underneath the school, so reusing it is most of the feature.
  const feed = (g.flee <= 0 && !bowRiding) ? chumPull(g.type, g.cx, g.cz, ctx.carcasses ?? []) : null;
  // The catch: nearly every species that comes to a carcass is a ROAMER, and spawn.ts gives a
  // roamer `anchor: null`. So a carcass has to be able to CREATE a patch, not only lean one that
  // already exists, or the feature would work for exactly the resident barracuda and nothing else.
  let patch = g.anchor;
  // Homing authority for a patch that only exists because of the carcass. Without it the
  // synthesized patch sits at the carcass with the feeding radius, so `pull` saturates at 1 even
  // 50 m out and the school charges in dead straight at full rate — the thing the comment above
  // says not to do. Scaling the turn rate by the carcass's own weight instead means a distant fish
  // bends toward it slowly, with its own wander still arguing, and only commits once it is close.
  let leanK = 1;
  if (feed) {
    // Copying the old patch keeps `hold` (the wreck layer's height-above-the-seabed band), and
    // that is on purpose: eight of the thirteen scavengers are also wreck residents, and one that
    // drifts over to a carcass should still be holding the water column it holds. It ends up
    // *under* the bird rather than at it, which for an amberjack stacked on steel is the right
    // picture anyway — nothing in this game asks a bottom-holding school to rise.
    patch = patch
      ? { ...patch, x: lerp(patch.x, feed.x, feed.k), z: lerp(patch.z, feed.z, feed.k), r: lerp(patch.r, CARCASS_MILL_R, feed.k) }
      : { x: feed.x, z: feed.z, r: CARCASS_MILL_R };
    if (!g.anchor) leanK = 0.25 + 0.75 * feed.k;
    // Food is on the TOP. Left alone, the dive cycle a few lines down would periodically take a
    // feeding school 14 m under its own meal; cancelling the target keeps them up where the bird
    // is. Bottom-dwellers are exempt: a goliath grouper comes up for the hit and lives down there,
    // which is both true to life and what `level: 'bottom'` placement already does.
    if (feed.k > 0.25 && V.level !== 'bottom') g.diveTarget = 0;
  }
  if (patch && g.flee <= 0 && !bowRiding) {
    // A diver hanging still is worth a look. Reef fish genuinely close on a motionless diver —
    // it is why you hold station and wait rather than chase — and without it the near-field layer
    // leaves you watching shapes at 9-10 m, which is the wrong end of an 11 m speargun.
    //
    // Modelled as the patch leaning toward the diver rather than the fish steering at them: the
    // school keeps milling over its own ground, that ground just shifts. So nothing charges you,
    // and the moment you fin hard the flee check above takes over and they are gone. Capped by
    // CURIOUS_PULL so a school never abandons its patch outright, and it fades with distance.
    let anx = patch.x, anz = patch.z;
    const curious = threats.find((th) => th.kind === 'diver' && th.speed <= CURIOUS_MAX_SPEED);
    if (curious) {
      const dd = Math.hypot(curious.x - g.cx, curious.z - g.cz);
      if (dd < CURIOUS_RANGE) {
        const calm = clamp((CURIOUS_MAX_SPEED - curious.speed) / (CURIOUS_MAX_SPEED - CURIOUS_FULL_SPEED), 0, 1);
        const k = CURIOUS_PULL * (1 - dd / CURIOUS_RANGE) * calm;
        anx += (curious.x - anx) * k;
        anz += (curious.z - anz) * k;
      }
    }
    const ax = g.cx - anx, az = g.cz - anz, d0 = Math.hypot(ax, az) || 1;
    const R = patch.r || 10;
    // <0 inside the patch, 0 at the edge, >0 outside. The -0.15 starts the pull just inside the
    // boundary so a school eases round instead of overshooting and visibly snapping back.
    const pull = clamp((d0 - R) / R + 0.15, 0, 1);
    if (pull > 0) {
      const dir = Math.sin(t * 0.07 + g.phase * 3.1) >= 0 ? 1 : -1;
const tang = 0.55 * (1 - pull); // fades out the further from home, so a stray school comes back
      const vx = (-ax / d0) * pull + (-az / d0) * dir * tang;
      const vz = (-az / d0) * pull + (ax / d0) * dir * tang;
      g.heading = angLerp(g.heading, Math.atan2(-vx, -vz), dt * 1.6 * (0.4 + pull) * leanK);
    }
    // Note this now also applies to a roamer that is merely within reach of a carcass: as soon as
    // one is in the water it drops to three-quarter cruise, for as long as it is in range. Left in
    // deliberately — a predator working a scent slows down and quarters it rather than steaming
    // through — but it is a behaviour change to a roaming school that no anchor gave it before.
    sp *= 0.75;
  }
  if (g.glide > 0) {
    g.glide -= dt;
    sp = 12;
    if (g.glide <= 0) { g.glide = 0; events.push({ type: 'splash', x: g.cx, z: g.cz, r: 3, p: 0.5 }); }
  }

  let fx = -Math.sin(g.heading), fz = -Math.cos(g.heading);
  const la = 5 + sp * 2, lx = g.cx + fx * la, lz = g.cz + fz * la, ld = depthAt(lx, lz);
  if (ld < V.dMin || ld > V.dMax * 1.5 || shoreInfo(lx, lz).d < 4) {
    if (!g.turn) g.turn = Math.random() < 0.5 ? -1 : 1;
    g.heading += g.turn * 1.8 * dt;
    sp *= 0.6;
    fx = -Math.sin(g.heading); fz = -Math.cos(g.heading);
  } else {
    g.turn = 0;
  }
  g.vx = fx * sp;
  g.vz = fz * sp;
  // Signed turn rate, wrapped into (-PI, PI] so crossing north is not read as a 2*PI spin. Eased
  // rather than taken raw: heading is nudged by several terms per step (wander, flee, anchor,
  // the boundary turn) and the raw frame-to-frame delta is spiky enough to make a bank flicker.
  if (dt > 0) {
    let dh = g.heading - heading0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    g.turnRate = lerp(g.turnRate, dh / dt, Math.min(1, dt * 4));
  }
  g.cx += g.vx * dt;
  g.cz += g.vz * dt;
  // keep a long-wandering school from drifting off the playable chart entirely
  g.cx = clamp(g.cx, WB.x0 + 5, WB.x1 - 5);
  g.cz = clamp(g.cz, WB.z0 + 5, WB.z1 - 5);

  const d = depthAt(g.cx, g.cz), floor = floorY(d);
  const rx = Math.cos(g.heading), rz = -Math.sin(g.heading);

  // dive cycles: sound for a while, then come back up; spooked fish head down
  g.diveTimer -= dt;
  if (g.diveTimer <= 0) {
    g.diveTarget = g.diveTarget > 0.3 ? 0 : (d > 3 ? rand(0.4, 1) : 0);
    g.diveTimer = g.diveTarget ? rand(5, 14) : rand(6, 18);
  }
  g.dive = lerp(g.dive, g.flee > 0 && d > 3 ? 0.9 : g.diveTarget, Math.min(1, dt * 0.35));

  const wf = 4 + sp * 3;
  const wa = (V.kind === 'ray' || V.kind === 'turtle' || V.kind === 'manatee') ? 0.03 : (V.kind === 'fish' ? 0.04 : 0.03);

  for (const m of g.members) stepMember(m, g, V, d, floor, rx, rz, fx, fz, wf, wa, t, dt, events);

  return events;
}

function stepMember(
  m: FishMember, g: SchoolState, V: CreatureVis,
  d: number, floor: number, rx: number, rz: number, fx: number, fz: number,
  wf: number, wa: number, t: number, dt: number, events: SchoolEvent[],
): void {
  const ox = m.ox + Math.sin(t * 0.6 + m.seed) * 0.3, oz = m.oz + Math.cos(t * 0.5 + m.seed) * 0.3;
  const mx = g.cx + rx * ox + fx * oz, mz = g.cz + rz * ox + fz * oz;
  const surf = seaHAt(mx, mz, t);

  let y: number;
  const hold = g.anchor?.hold;
  if (hold && V.level !== 'bottom') y = clamp(floor + hold.h + m.oy * hold.r, floor + 0.4, surf - 0.6);
  else if (V.level === 'surface') {
    // A "surface" species is one that works the top of the water column, not one that lives with
    // its back out of it. These used to sit at a flat `surf - 0.5` always, so a school of tuna
    // was permanently skimming the surface whether it was feeding or not; from the helm the
    // ocean looked like it had tuna lying on it. They cruise at a real depth now and come up for
    // a reason — see the frenzy below.
    y = surf - SURFACE_CRUISE_M - (m.oy + 1) * 0.6;
    if (g.frenzy > 0) {
      // Up together when the school is busting, and back down as it dies off.
      const up = Math.min(1, g.frenzy / FRENZY_RISE_S);
      y = lerp(y, surf - 0.5 - (m.oy + 1) * 0.15, up);
    }
    y = Math.max(floor + 0.4, y);
  } else if (V.level === 'bottom') y = floor + 0.25 + (m.oy + 1) * 0.05;
  else y = clamp(lerp(floor + 0.35, surf - 0.45, MID_LEVEL + m.oy * 0.2), floor + 0.2, surf - 0.35);
  if (g.dive > 0 && V.level !== 'bottom' && !hold) y = lerp(y, Math.max(floor + 0.5, surf - Math.min(14, (surf - floor) * 0.85)), g.dive);

  let pitch = 0, roll = 0;
  if (V.act && V.act !== 'glide') {
    m.actTimer -= dt;
    // A bust is the frenzy, so a member may only bust while its school is having one. Without
    // this each one surfaced on its own 2-8 s timer, which is not a frenzy, it is a fidget.
    const actReady = V.act !== 'bust' || g.frenzy > 0;
    if (!m.act && m.actTimer <= 0 && g.flee <= 0 && actReady && (V.act !== 'tail' || d < 2.6)) {
      m.act = V.act; m.actPhase = 0; m.splashed = false; m.splashed2 = false;
      // Rare bonus breach (task brief: "if you're feeling ambitious, a rare breach") — humpback
      // only, rolled fresh each time a blow cycle starts. Cosmetic timing only (same precedent as
      // the glide roll above), not placement, so plain Math.random() is fine here.
      m.breaching = V.act === 'blow' && g.type === 'humpback' && Math.random() < 0.04;
    }
    if (m.act) {
      m.actPhase += dt / ACT_DUR[m.act];
      const p = Math.min(1, m.actPhase), k = Math.sin(p * Math.PI);
      if (m.act === 'tail') { pitch = -0.95 * k; y = lerp(y, surf - 0.08, k); }
      else if (m.act === 'roll') { y = surf - 0.9 + k * 1.15; pitch = Math.cos(p * Math.PI) * 0.7; if (p > 0.45 && !m.splashed) { m.splashed = true; events.push({ type: 'splash', x: mx, z: mz, r: 7, p: 0.6 }); } }
      else if (m.act === 'bust') { y = lerp(y, surf + 0.25, k); pitch = Math.cos(p * Math.PI) * 0.6; if (p > 0.4 && !m.splashed) { m.splashed = true; events.push({ type: 'splash', x: mx, z: mz, r: 9, p: 0.8 }); } }
      else if (m.act === 'breathe') { y = lerp(y, surf - 0.1, k); pitch = 0.22 * k; }
      else if (m.act === 'porpoise') { y = surf - 0.6 + k * 1.35; pitch = Math.cos(p * Math.PI) * 0.8; if (p > 0.85 && !m.splashed) { m.splashed = true; events.push({ type: 'splash', x: mx, z: mz, r: 6, p: 0.6 }); } }
      else if (m.act === 'blow') {
        // Whale surfacing-to-breathe cycle: a nose-up rise with a blow near the peak, then a
        // nose-down fluke-up as it sounds back under (task brief: "a blow/spout on surfacing...
        // occasional fluke-up on sounding"). `m.breaching` swaps in a bigger lunge + a real
        // splash instead of the usual gentle roll and blow.
        const rise = m.breaching ? 1.6 : 0.35;
        y = lerp(y, surf - 0.25 + rise, k);
        pitch = Math.cos(p * Math.PI) * (m.breaching ? 1.1 : 0.5);
        if (p > 0.35 && p < 0.6 && !m.splashed) {
          m.splashed = true;
          events.push(m.breaching
            ? { type: 'splash', x: mx, z: mz, r: 14, p: 1 }
            : { type: 'blow', x: mx, y: surf, z: mz });
        }
        if (p > 0.82 && !m.splashed2) {
          m.splashed2 = true;
          events.push({ type: 'splash', x: mx, z: mz, r: 9, p: 0.7 }); // fluke breaking the surface on the way back down
        }
      }
      if (m.actPhase >= 1) { m.act = null; const cd = ACT_CD[V.act]; m.actTimer = rand(cd[0], cd[1]); }
    }
  }
  if (g.glide > 0) { y = surf + 0.45 + Math.sin(t * 3 + m.seed) * 0.12; pitch = 0.05; }
  if (V.flap) roll = Math.sin(t * 2.2 + m.seed) * 0.28;
  else if (V.kind === 'ray') roll = Math.sin(t * 1.5 + m.seed) * 0.05;
  // A flatfish lies over on one side (content/creatures.ts's `flat`). The body is authored
  // upright like every other fish, so laying it over is a quarter turn here rather than a second
  // geometry path: the deep-and-thin loft becomes a wide flat one, the dorsal and anal fringes
  // end up running down its two long edges, and the baked lateral swim bend sweeps vertically,
  // which is how a flatfish actually undulates. The small wobble is the fringe rippling, not a
  // bank — a fish lying on the bottom has no corner to lean into.
  else if (V.flat) roll = Math.PI / 2 + Math.sin(t * 1.1 + m.seed) * 0.04;

  // Bank into the turn. A fish leans INTO a corner, so a left turn rolls it left — and a slow
  // heavy body leans less for the same corner than a quick one, which is why this is scaled by
  // cruise speed rather than being one constant. Capped: a school hard against the world
  // boundary turns fast enough to put a fish on its side otherwise.
  if (!V.flap && !V.flat) {
    const bank = clamp(-g.turnRate * (0.30 + 0.10 * V.speed), -BANK_MAX, BANK_MAX);
    m.bank = lerp(m.bank, bank, Math.min(1, dt * 3));
    roll += m.bank;
  }

  // Tail-beat rate follows how fast this fish is ACTUALLY going. The VAT bakes one rate per
  // species, so without this a school milling over its patch at 0.75x cruise and a school
  // bolting at 2.2x beat identically — which is the single most obviously wrong thing about a
  // school at rest. Only the DIFFERENCE from cruise is accumulated, so a fish at cruise looks
  // exactly as it did.
  //
  // Scaled by THIS species' baked rate, not the old global 7.5: that constant is no longer what
  // anything beats at (swim.ts derives the rate from length and swimming mode), so using it here
  // would have over-driven a slow-beating marlin and under-driven a baitfish.
  const spd = Math.hypot(g.vx, g.vz);
  const rate = clamp(spd / Math.max(0.05, V.speed), BEAT_MIN, BEAT_MAX);
  m.swimPhase += (rate - 1) * swimAngSpeed(g.type, V) * dt;

  const yaw = g.heading + Math.sin(t * wf + m.seed) * (g.glide > 0 ? 0 : wa);
  m.wx = mx; m.wy = y; m.wz = mz;
  m.yaw = yaw; m.pitch = pitch; m.roll = roll;
  m.worldScale = m.scale;
}

/** Offshore fish run slightly larger out in the Gulf Stream — legacy's inline
 * `VSC*rand(.8,1.15)*(V.dMin>=25?1+.45*offshoreF(x,z):1)` member-scale roll (index.html:2501),
 * exposed here so spawn.ts can reuse the exact same formula for both resident and roaming members. */
export function memberScale(baseScale: number, V: CreatureVis, x: number, z: number): number {
  return baseScale * (V.dMin >= 25 ? 1 + 0.45 * offshoreF(x, z) : 1);
}
