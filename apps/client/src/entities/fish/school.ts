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
import { ampFor, waveHBase } from '@keysrun/shared/waves';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { clamp, lerp, rand } from '../../core/math.js';
import {
  angLerp, fleeClassFor, fleeParamsFor, nearestTrigger, ACT_DUR, ACT_CD,
  isBowRider, bowRideTarget, BOW_RIDE_RADIUS, BOW_RIDE_MIN_SPEED, BOW_RIDE_MAX_SPEED,
} from './behavior.js';
import type { SchoolCtx, SchoolState, FishMember } from './types.js';

/** legacy `floorY` (apps/client/src/world/seafloor.ts, out of this task's ownership) — duplicated
 * as the one-line pure formula it is rather than importing a file that also drags in three.js,
 * per this module's "no three.js" header note. docs/ARCHITECTURE.md already tracks floorY's own
 * hazard/call-site count; this is call site #7, now documented here too. */
const floorY = (d: number): number => -(0.25 + Math.min(d, 14) * 0.55);

/** The seafloor/surface world-Y pair at a point — the same two numbers `stepMember` uses to place
 * every member's `y` (`level==='bottom'|'surface'|'mid'`, see below). Exported so a caller that
 * isn't stepping a school (verification tooling, a future camera/diver buoyancy query) can place
 * something in the water column without re-deriving the formula — see index.ts's `waterColumnAt`
 * and test/capture-fish-screenshots.mjs, which uses it to put a camera at fish-eye height instead
 * of guessing a world Y blind. */
export function waterColumnAt(x: number, z: number, t: number): { floor: number; surf: number } {
  const d = depthAt(x, z);
  return { floor: floorY(d), surf: waveHBase(x, z, t, ampFor(d)) };
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

  const cls = fleeClassFor(g.type, V);
  const trigger = nearestTrigger(g.cx, g.cz, cls, triggerThreats);
  if (trigger) {
    if (g.flee <= 0 && V.act === 'glide' && !g.glide) g.glide = rand(1.6, 3.4);
    g.flee = 1.5;
    g.fleeHeading = Math.atan2(-(trigger.x - g.cx), -(trigger.z - g.cz));
  }
  if (V.act === 'glide' && !g.glide && Math.random() < dt * 0.03) g.glide = rand(1.6, 3.4);

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

  if (g.anchor && g.flee <= 0 && !bowRiding) {
    const ax = g.cx - g.anchor.x, az = g.cz - g.anchor.z, d0 = Math.hypot(ax, az) || 1;
    const R = g.anchor.r || 10, dir = (g.phase % 2) < 1 ? 1 : -1, rc = clamp((R - d0) / R, -1, 1) * 0.9;
    const vx = -az / d0 * dir + ax / d0 * rc, vz = ax / d0 * dir + az / d0 * rc;
    g.heading = angLerp(g.heading, Math.atan2(-vx, -vz), dt * 2);
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
  g.cx += fx * sp * dt;
  g.cz += fz * sp * dt;
  // keep a long-wandering school from drifting off the playable chart entirely
  g.cx = clamp(g.cx, WB.x0 + 5, WB.x1 - 5);
  g.cz = clamp(g.cz, WB.z0 + 5, WB.z1 - 5);

  const d = depthAt(g.cx, g.cz), amp = ampFor(d), floor = floorY(d);
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

  for (const m of g.members) stepMember(m, g, V, d, amp, floor, rx, rz, fx, fz, wf, wa, t, dt, events);

  return events;
}

function stepMember(
  m: FishMember, g: SchoolState, V: CreatureVis,
  d: number, amp: number, floor: number, rx: number, rz: number, fx: number, fz: number,
  wf: number, wa: number, t: number, dt: number, events: SchoolEvent[],
): void {
  const ox = m.ox + Math.sin(t * 0.6 + m.swimPhase) * 0.3, oz = m.oz + Math.cos(t * 0.5 + m.swimPhase) * 0.3;
  const mx = g.cx + rx * ox + fx * oz, mz = g.cz + rz * ox + fz * oz;
  const surf = waveHBase(mx, mz, t, amp);

  let y: number;
  if (V.level === 'surface') y = surf - 0.5 - (m.oy + 1) * 0.15;
  else if (V.level === 'bottom') y = floor + 0.25 + (m.oy + 1) * 0.05;
  else y = clamp(lerp(floor + 0.35, surf - 0.45, 0.55 + m.oy * 0.2), floor + 0.2, surf - 0.35);
  if (g.dive > 0 && V.level !== 'bottom') y = lerp(y, Math.max(floor + 0.5, surf - Math.min(14, (surf - floor) * 0.85)), g.dive);

  let pitch = 0, roll = 0;
  if (V.act && V.act !== 'glide') {
    m.actTimer -= dt;
    if (!m.act && m.actTimer <= 0 && g.flee <= 0 && (V.act !== 'tail' || d < 2.6)) {
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
      else if (m.act === 'bust') { y = surf - 0.5 + k * 0.75; pitch = Math.cos(p * Math.PI) * 0.6; if (p > 0.4 && !m.splashed) { m.splashed = true; events.push({ type: 'splash', x: mx, z: mz, r: 9, p: 0.8 }); } }
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
  if (g.glide > 0) { y = surf + 0.45 + Math.sin(t * 3 + m.swimPhase) * 0.12; pitch = 0.05; }
  if (V.flap) roll = Math.sin(t * 2.2 + m.swimPhase) * 0.28;
  else if (V.kind === 'ray') roll = Math.sin(t * 1.5 + m.swimPhase) * 0.05;

  const yaw = g.heading + Math.sin(t * wf + m.swimPhase) * (g.glide > 0 ? 0 : wa);
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
