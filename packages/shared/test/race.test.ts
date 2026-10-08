import { describe, expect, it } from 'vitest';
import { depthAt, landH } from '../src/world/depth.js';
import { shoreInfo } from '../src/world/chain.js';
import {
  MARATHON_COURSE, BUOY_RADIUS, RACE_COUNTDOWN_S,
  buoyPos, coursePoints, courseLength, createRace, startRace, abortRace, stepRace,
  raceProgress, standings, syncRacers,
  type RaceState,
} from '../src/sim/race.js';

const DT = 1 / 30;

/** Drives `id` round the course, teleporting onto each buoy in turn, for `laps` laps. */
function driveLaps(state: RaceState, id: string, laps: number): RaceState {
  let s = state;
  for (let lap = 0; lap < laps; lap++) {
    for (let i = 0; i < MARATHON_COURSE.length; i++) {
      const p = buoyPos(MARATHON_COURSE[i]);
      s = stepRace(s, [{ id, x: p.x, z: p.z }], DT);
    }
  }
  return s;
}

/** Runs the countdown out so the race is live. */
function release(state: RaceState): RaceState {
  let s = startRace(state);
  for (let i = 0; i < Math.ceil(RACE_COUNTDOWN_S / DT) + 2; i++) {
    s = stepRace(s, [], DT);
    if (s.phase === 'racing') break;
  }
  return s;
}

describe('the course', () => {
  it('every buoy is in navigable open water', () => {
    // A buoy on a flat or inside an island is an unreachable checkpoint that soft-locks the lap,
    // so this is asserted against the real world functions rather than eyeballed on a map.
    for (const b of MARATHON_COURSE) {
      const p = buoyPos(b);
      expect(depthAt(p.x, p.z), `${b.name} depth`).toBeGreaterThan(2.5);
      expect(landH(p.x, p.z), `${b.name} is on land`).toBeLessThanOrEqual(0.2);
      expect(shoreInfo(p.x, p.z).d, `${b.name} too close to shore`).toBeGreaterThan(40);
    }
  });

  it('is a real lap, not a few metres of jitter', () => {
    expect(courseLength()).toBeGreaterThan(4000);
    expect(coursePoints()).toHaveLength(MARATHON_COURSE.length);
  });

  it('has no two buoys close enough to be rounded by one pass', () => {
    // Overlapping capture radii would let a single position satisfy two checkpoints at once.
    for (let i = 0; i < MARATHON_COURSE.length; i++) {
      for (let j = i + 1; j < MARATHON_COURSE.length; j++) {
        const a = buoyPos(MARATHON_COURSE[i]), b = buoyPos(MARATHON_COURSE[j]);
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(BUOY_RADIUS * 2);
      }
    }
  });
});

describe('race lifecycle', () => {
  it('starts idle and does nothing until started', () => {
    const r = createRace(['player']);
    expect(r.phase).toBe('idle');
    const after = stepRace(r, [{ id: 'player', x: 0, z: 0 }], DT);
    expect(after).toBe(r); // untouched reference — genuinely a no-op
  });

  it('runs a countdown, then releases', () => {
    let s = startRace(createRace(['player']));
    expect(s.phase).toBe('countdown');
    expect(s.clock).toBeCloseTo(RACE_COUNTDOWN_S, 6);
    s = release(s);
    expect(s.phase).toBe('racing');
    expect(s.clock).toBeCloseTo(0, 1);
  });

  it('a second start during a race is ignored', () => {
    const racing = release(createRace(['player']));
    expect(startRace(racing)).toBe(racing);
  });

  it('abort returns to idle', () => {
    expect(abortRace(release(createRace(['player']))).phase).toBe('idle');
  });

  it('the clock counts up once racing', () => {
    let s = release(createRace(['player']));
    const t0 = s.clock;
    for (let i = 0; i < 30; i++) s = stepRace(s, [{ id: 'player', x: 0, z: 0 }], DT);
    expect(s.clock).toBeGreaterThan(t0 + 0.9);
  });
});

describe('checkpoints', () => {
  it('rounding buoys in order advances and completes laps', () => {
    let s = release(createRace(['player'], 2));
    s = driveLaps(s, 'player', 1);
    expect(s.racers[0].lap).toBe(1);
    s = driveLaps(s, 'player', 1);
    expect(s.racers[0].finishT).not.toBeNull();
    expect(s.racers[0].place).toBe(1);
  });

  it('CANNOT be skipped — sitting on the finish never completes a lap', () => {
    // The cheat the ordered-checkpoint design exists to stop: park on the start/finish buoy and
    // wait. Without ordering this would rack up laps; with it, `next` is stuck at buoy 1.
    let s = release(createRace(['player'], 1));
    const p = buoyPos(MARATHON_COURSE[0]);
    for (let i = 0; i < 600; i++) s = stepRace(s, [{ id: 'player', x: p.x, z: p.z }], DT);
    expect(s.racers[0].lap).toBe(0);
    expect(s.racers[0].finishT).toBeNull();
    expect(s.racers[0].next).toBe(1);
  });

  it('CANNOT be short-cut — skipping the back half leaves the lap incomplete', () => {
    let s = release(createRace(['player'], 1));
    // Round the first three marks, then jump straight to the last one and sit there.
    for (let i = 0; i < 3; i++) {
      const p = buoyPos(MARATHON_COURSE[i]);
      s = stepRace(s, [{ id: 'player', x: p.x, z: p.z }], DT);
    }
    const last = buoyPos(MARATHON_COURSE[MARATHON_COURSE.length - 1]);
    for (let i = 0; i < 300; i++) s = stepRace(s, [{ id: 'player', x: last.x, z: last.z }], DT);
    expect(s.racers[0].lap).toBe(0);
    expect(s.racers[0].next).toBe(3);
  });

  it('a near miss outside the radius does not count', () => {
    let s = release(createRace(['player'], 1));
    const p = buoyPos(MARATHON_COURSE[0]);
    s = stepRace(s, [{ id: 'player', x: p.x + BUOY_RADIUS + 5, z: p.z }], DT);
    expect(s.racers[0].next).toBe(0);
  });

  it('emits buoy, lap and finish events', () => {
    let s = release(createRace(['player'], 1));
    const kinds = new Set<string>();
    for (let i = 0; i < MARATHON_COURSE.length; i++) {
      const p = buoyPos(MARATHON_COURSE[i]);
      s = stepRace(s, [{ id: 'player', x: p.x, z: p.z }], DT);
      for (const e of s.events) kinds.add(e.type);
    }
    expect(kinds.has('buoy')).toBe(true);
    expect(kinds.has('finish')).toBe(true);
  });
});

describe('field scoring', () => {
  it('assigns places in finishing order', () => {
    let s = release(createRace(['a', 'b'], 1));
    s = driveLaps(s, 'a', 1);
    s = driveLaps(s, 'b', 1);
    const a = s.racers.find((r) => r.id === 'a');
    const b = s.racers.find((r) => r.id === 'b');
    expect(a?.place).toBe(1);
    expect(b?.place).toBe(2);
    expect(s.phase).toBe('finished');
  });

  it('standings rank by progress while still running', () => {
    let s = release(createRace(['ahead', 'behind'], 2));
    for (let i = 0; i < 5; i++) {
      const p = buoyPos(MARATHON_COURSE[i]);
      s = stepRace(s, [{ id: 'ahead', x: p.x, z: p.z }], DT);
    }
    expect(standings(s)[0].id).toBe('ahead');
  });

  it('progress runs 0..1 across the full race', () => {
    const s = release(createRace(['p'], 2));
    expect(raceProgress(s.racers[0], 2)).toBe(0);
    const done = driveLaps(s, 'p', 2);
    expect(raceProgress(done.racers[0], 2)).toBeCloseTo(1, 6);
  });

  it('a racer with no reported pose simply does not advance', () => {
    let s = release(createRace(['present', 'missing'], 1));
    const p = buoyPos(MARATHON_COURSE[0]);
    s = stepRace(s, [{ id: 'present', x: p.x, z: p.z }], DT);
    expect(s.racers.find((r) => r.id === 'missing')?.next).toBe(0);
  });
});

describe('a field that changes mid-race (networked players joining and dropping)', () => {
  it('returns the same reference when the field is unchanged', () => {
    const s = release(createRace(['player', 'ai0']));
    expect(syncRacers(s, ['player', 'ai0'])).toBe(s);
  });

  it('adds a late joiner at the start of the course without disturbing anyone', () => {
    let s = release(createRace(['player'], 2));
    for (let i = 0; i < 4; i++) {
      const p = buoyPos(MARATHON_COURSE[i]);
      s = stepRace(s, [{ id: 'player', x: p.x, z: p.z }], DT);
    }
    const before = s.racers.find((r) => r.id === 'player');
    s = syncRacers(s, ['player', 'net7']);
    const after = s.racers.find((r) => r.id === 'player');
    expect(after).toEqual(before);                       // existing progress untouched
    expect(s.racers.find((r) => r.id === 'net7')?.next).toBe(0); // genuinely behind
  });

  it('drops a departed player and leaves no hole in the places', () => {
    let s = release(createRace(['a', 'b', 'c'], 1));
    s = driveLaps(s, 'a', 1);
    s = driveLaps(s, 'b', 1);
    expect(s.racers.find((r) => r.id === 'a')?.place).toBe(1);
    expect(s.racers.find((r) => r.id === 'b')?.place).toBe(2);
    // The winner disconnects — second place must become first, not stay 2 with a gap at 1.
    s = syncRacers(s, ['b', 'c']);
    expect(s.racers.find((r) => r.id === 'b')?.place).toBe(1);
    expect(s.finished).toBe(1);
    expect(s.racers.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('keeps scoring correctly after the field changes', () => {
    let s = release(createRace(['player'], 1));
    s = syncRacers(s, ['player', 'net3']);
    s = driveLaps(s, 'net3', 1);
    expect(s.racers.find((r) => r.id === 'net3')?.place).toBe(1);
    expect(s.racers.find((r) => r.id === 'player')?.finishT).toBeNull();
  });

  it('preserves entrant order so the pose array and the racer list stay aligned', () => {
    const s = syncRacers(release(createRace(['player', 'ai0'])), ['player', 'ai0', 'net1', 'net2']);
    expect(s.racers.map((r) => r.id)).toEqual(['player', 'ai0', 'net1', 'net2']);
  });
});
