/**
 * Core sound engine: the supercharged cross-plane V8 synth (legacy's Mercury Racing 450R voice,
 * run by every powered boat in the game), HRTF-panned one-shots, noise-loop water/wind ambience,
 * the reel's drag scream, doppler go-fast passes, remote boats' motors, and gull calls over bait.
 *
 * Ported faithfully from legacy/index.html:3054-3216 (`AUD`), restructured from one mutable
 * global into a factory (`createAudioEngine()`) so a test harness can own an instance without
 * touching module state, and from positional globals (`camera`, `boat`, `boatSpec`, `game`,
 * `TRIM`, `GEAR`, `SEA`, `F`, `BUDDY`, `TRAFFIC`, `RACERS`, `MP.ghosts`, `hotspots`) to explicit
 * per-frame inputs (`AudioFrameInputs`) — see `interfaces.ts` for the remote-engine/gull-site
 * shapes and docs/ARCHITECTURE.md's authority model for why boat state lives in
 * `@keysrun/shared/sim/boat`, not here.
 *
 * `AUD.update`'s reel/buddy/traffic/racer/ghost/gull sections are all live code paths: they do
 * nothing when the caller passes no `reel`/`buddy`/`traffic`/`racers`/`ghosts`/`gullSites` (true
 * today, since those systems are either phase-3+ or integrated elsewhere), and start working the
 * moment real data flows in — nothing here is a stub.
 */
import { clamp, lerp, rand } from '../core/math.js';
import type { Boat } from '@keysrun/shared/content/boats';
import type { RemoteEngineSource, GullSite } from './interfaces.js';

// ---------------------------------------------------------------------------------------------
// Engine voice profiles (legacy index.html:3063-3066)
// ---------------------------------------------------------------------------------------------

export interface EngineProfile {
  v8: boolean;
  rough: number;
  whine: number;
  vol: number;
  idle: number;
  max: number;
  tone: number;
  racing: boolean;
  /** Legacy `p.thru` — unset (falsy) for every profile in this game; kept for fidelity. */
  thru?: boolean;
}

const ENGINE_VOL = 0.07; // overall motor loudness (1 = original)

const ENG450: EngineProfile = { v8: true, rough: 0.8, whine: 1, vol: 1.08, idle: 700, max: 6400, tone: 1.25, racing: true };

/** Every powered boat in the game runs the same supercharged racing V8 voice, keyed by boat id
 * (plus `gofast` for the go-fast racer NPCs). */
const ENGINES: Record<string, EngineProfile> = {
  robalo: ENG450, grady: ENG450, freeman: ENG450, midnight: ENG450, mti: ENG450,
  gofast: { ...ENG450, vol: 1.35 },
};

function engineProfileFor(id: string): EngineProfile {
  return ENGINES[id] ?? ENGINES.grady;
}

// ---------------------------------------------------------------------------------------------
// Low-level WebAudio helpers
// ---------------------------------------------------------------------------------------------

interface OscEntry {
  o: OscillatorNode;
  lfo: OscillatorNode;
  ld: GainNode;
  g: GainNode;
  base: number;
  i: number;
  ph: number;
  off: number;
  mul: number;
  gate: number;
  startAt: number | null;
}

interface EngineSynth {
  prof: EngineProfile;
  n: number;
  out: GainNode;
  panner: PannerNode | null;
  oscs: OscEntry[];
  muffle: BiquadFilterNode;
  relief: GainNode;
  sub: OscillatorNode;
  sg: GainNode;
  bg: GainNode;
  ed: GainNode;
  ig: GainNode;
  ibp: BiquadFilterNode;
  gw: OscillatorNode;
  gg: GainNode;
  wh: { o: OscillatorNode; o2: OscillatorNode; g: GainNode } | null;
  rpm: number;
  dispose(): void;
}

interface NoiseLoop { f: BiquadFilterNode; g: GainNode }

function webkitAudioContextCtor(): typeof AudioContext | undefined {
  return (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

// ---------------------------------------------------------------------------------------------
// Per-frame input shapes (legacy read these off `camera`/`boat`/`boatSpec`/`TRIM`/`GEAR`/`SEA`/
// `F`/`BUDDY`/`TRAFFIC`/`RACERS`/`MP.ghosts`/`hotspots` directly; here they're explicit so this
// module has zero dependency on game/world.ts, which owns wiring real values into them each frame).
// ---------------------------------------------------------------------------------------------

export interface ListenerPose { x: number; y: number; z: number; fx: number; fy: number; fz: number }

export interface PlayerEngineInputs {
  boatId: string;
  /** boatSpec.top * 0.5144 * SPEED_SCALE, i.e. top speed in m/s. */
  topMs: number;
  /** Signed speed, m/s. */
  speed: number;
  /** Signed throttle, -1..1. */
  throttle: number;
  trimV: number;
  trimVent: number;
  ventilating: boolean;
  /** 0..1, revving in neutral (legacy `GEAR.rev`). */
  gearRev: number;
  /** Whether gameplay is actually running (legacy `game.running`) — ducks volume when not. */
  running: boolean;
}

export type ReelAudioMode = 'idle' | 'fightRunning' | 'fightHeld' | 'reelingNoTension';
export interface ReelAudioState { mode: ReelAudioMode; drag: number; bobX: number; bobZ: number }

export interface AudioFrameInputs {
  t: number;
  dt: number;
  listener: ListenerPose;
  player: PlayerEngineInputs;
  sw: number;
  ch: number;
  reel?: ReelAudioState;
  buddy?: RemoteEngineSource;
  traffic?: readonly RemoteEngineSource[];
  racers?: readonly RemoteEngineSource[];
  ghosts?: readonly RemoteEngineSource[];
  gullSites?: readonly GullSite[];
}

export function createAudioEngine() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let bus: GainNode | null = null;
  // Underwater muffle insert (NEW — not in legacy, which has no underwater at all): every topside
  // sound routed through `bus` (engines, water/wind ambience, bursts, gull calls, reel) passes
  // through this lowpass before the compressor, so `audio/underwater.ts` can crossfade one knob
  // on the surface crossing instead of touching every source. `underwaterBus` is a second,
  // parallel path straight to the compressor for underwater's *own* sources (breathing, bubbles,
  // reef crackle) — those should never be muffled by the same filter that's muffling topside.
  let underwaterFilter: BiquadFilterNode | null = null;
  let underwaterBus: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let on = true;
  let ready = false;
  let player: EngineSynth | null = null;
  let playerBoatId = 'grady';
  let lastSplash = 0;
  let gullT = 2;
  let prevThr = 0;

  let rush: NoiseLoop | null = null, hiss: NoiseLoop | null = null, wind: NoiseLoop | null = null, wash: NoiseLoop | null = null;
  let reel: { tone: OscillatorNode; lfo: OscillatorNode; depth: GainNode } | null = null;

  const engineOn = { v: true, startT: -1 };

  // remote-boat synths, keyed by the caller-supplied stable id (traffic/racer/buddy/ghost)
  const remoteSynths = new Map<string, EngineSynth>();
  const remotePrev = new Map<string, { x: number; z: number }>();
  const remoteGhostVs = new Map<string, number>();
  let prevListener: { x: number; z: number } | null = null;

  function requireBus(): GainNode {
    if (!bus) throw new Error('audio engine not ready');
    return bus;
  }

  function audPos(p: PannerNode, x: number, y: number, z: number): void {
    const t = ctx!.currentTime;
    p.positionX.setTargetAtTime(x, t, 0.04);
    p.positionY.setTargetAtTime(y, t, 0.04);
    p.positionZ.setTargetAtTime(z, t, 0.04);
  }

  function audPanner(): PannerNode {
    const c = ctx!;
    const p = c.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 12;
    p.rolloffFactor = 1.1;
    p.maxDistance = 4000;
    p.connect(requireBus());
    return p;
  }

  function audNoiseSrc(): AudioBufferSourceNode {
    const c = ctx!;
    const s = c.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    s.start(0, Math.random() * 1.8);
    return s;
  }

  function audShaper(k: number): WaveShaperNode {
    const c = ctx!;
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    const w = c.createWaveShaper();
    w.curve = curve;
    w.oversample = '2x';
    return w;
  }

  /** legacy `engineWave` (index.html:3067-3069) — a cross-plane V8 firing-order spectrum. */
  function engineWave(rough: number): PeriodicWave {
    const c = ctx!;
    const N = 40;
    const re = new Float32Array(N), im = new Float32Array(N);
    const H: Record<number, number> = { 1: 0.32, 2: 0.75 * (0.6 + rough), 3: 0.16, 4: 1, 5: 0.08, 6: 0.32, 7: 0.05, 8: 0.46, 10: 0.14, 12: 0.26, 14: 0.07, 16: 0.18, 20: 0.09, 24: 0.07, 32: 0.04 };
    for (const k of Object.keys(H)) {
      const i = +k;
      if (i < N) { im[i] += H[i]; re[i] += H[i] * 0.45 * Math.sin(i * 1.7); }
    }
    return c.createPeriodicWave(re, im);
  }

  /** legacy `makeEngineSynth` (index.html:3070-3090). */
  function makeEngineSynth(prof: EngineProfile, count: number, spatial: boolean): EngineSynth {
    const c = ctx!;
    const out = c.createGain(); out.gain.value = 0;
    const panner = spatial ? audPanner() : null;
    out.connect(panner ?? requireBus());
    const wave = engineWave(prof.rough);
    const n = Math.min(count, 4);
    const oscs: OscEntry[] = [];
    const nodes: Array<OscillatorNode | AudioBufferSourceNode> = [];
    const muffle = c.createBiquadFilter(); muffle.type = 'lowpass'; muffle.Q.value = 1.1; muffle.connect(out);
    const reliefHP = c.createBiquadFilter(); reliefHP.type = 'highpass'; reliefHP.frequency.value = 260;
    const relief = c.createGain(); relief.gain.value = 0;
    const rasp = audShaper(8 + prof.rough * 40);
    reliefHP.connect(rasp); rasp.connect(relief); relief.connect(out);
    for (let i = 0; i < n; i++) {
      const o = c.createOscillator(); o.setPeriodicWave(wave);
      const g = c.createGain(); g.gain.value = 0.6 / Math.sqrt(n);
      const lope = c.createGain(); lope.gain.value = 1;
      const lfo = c.createOscillator(); lfo.type = 'sine';
      const ld = c.createGain(); ld.gain.value = 0;
      lfo.connect(ld); ld.connect(lope.gain);
      let node: AudioNode = lope;
      if (!spatial && n > 1 && c.createStereoPanner) {
        const sp = c.createStereoPanner();
        sp.pan.value = ((i - (n - 1) / 2) / ((n - 1) / 2 || 1)) * 0.55;
        lope.connect(sp); node = sp;
      }
      o.connect(g); g.connect(lope); node.connect(muffle); node.connect(reliefHP);
      o.start(); lfo.start();
      oscs.push({ o, lfo, ld, g, base: 0.6 / Math.sqrt(n), i, ph: Math.random() * 6, off: (i - (n - 1) / 2) * 0.0009, mul: 1, gate: 1, startAt: null });
      nodes.push(o, lfo);
    }
    const sub = c.createOscillator(); sub.type = 'sine';
    const sg = c.createGain(); sg.gain.value = 0;
    sub.connect(sg); sg.connect(out); sub.start(); nodes.push(sub);

    const bub = audNoiseSrc(); const bbp = c.createBiquadFilter(); bbp.type = 'bandpass'; bbp.frequency.value = 170; bbp.Q.value = 1.2;
    const bg = c.createGain(); bg.gain.value = 0;
    const env = audNoiseSrc(); const elp = c.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 7;
    const ed = c.createGain(); ed.gain.value = 0;
    bub.connect(bbp); bbp.connect(bg); bg.connect(out);
    env.connect(elp); elp.connect(ed); ed.connect(bg.gain);
    nodes.push(bub, env);

    const ins = audNoiseSrc(); const ibp = c.createBiquadFilter(); ibp.type = 'bandpass'; ibp.frequency.value = 1100; ibp.Q.value = 1.1;
    const ig = c.createGain(); ig.gain.value = 0;
    ins.connect(ibp); ibp.connect(ig); ig.connect(out); nodes.push(ins);

    const gw = c.createOscillator(); gw.type = 'sine';
    const gg = c.createGain(); gg.gain.value = 0;
    gw.connect(gg); gg.connect(out); gw.start(); nodes.push(gw);

    let wh: EngineSynth['wh'] = null;
    if (prof.whine > 0) {
      const o = c.createOscillator(); o.type = 'sine';
      const o2 = c.createOscillator(); o2.type = 'sine';
      const g = c.createGain(); g.gain.value = 0;
      o.connect(g); o2.connect(g); g.connect(out);
      o.start(); o2.start();
      wh = { o, o2, g };
      nodes.push(o, o2);
    }

    return {
      prof, n, out, panner, oscs, muffle, relief, sub, sg, bg, ed, ig, ibp, gw, gg, wh, rpm: prof.idle,
      dispose() {
        nodes.forEach((x) => { try { x.stop(); } catch { /* already stopped */ } });
        try { out.disconnect(); panner?.disconnect(); } catch { /* already disconnected */ }
      },
    };
  }

  /** legacy `setEngine` (index.html:3091-3106). */
  function setEngine(sy: EngineSynth, rpm: number, load: number, vol: number, pitchMul: number): void {
    const c = ctx!;
    const t = c.currentTime, p = sy.prof, crank = (rpm / 60) * pitchMul;
    const r = clamp((rpm - p.idle) / (p.max - p.idle), 0, 1.2);
    const lo = Math.pow(1 - Math.min(r, 1), 2);
    sy.oscs.forEach((e) => {
      const det = 1 + e.off + 0.0012 * Math.sin(t * (0.17 + e.i * 0.05) + e.ph) * (1 - 0.6 * Math.min(r, 1));
      const hunt = p.racing ? 1 + 0.035 * lo * Math.sin(t * (2.1 + e.i * 0.37) + e.ph) + 0.02 * lo * Math.sin(t * 5.3 + e.ph * 2) : 1;
      e.o.frequency.setTargetAtTime(crank * det * hunt * e.mul, t, 0.04);
      e.g.gain.setTargetAtTime(e.base * e.gate, t, 0.05);
      e.lfo.frequency.setTargetAtTime(crank * 0.5 * det * e.mul * (1 + 0.04 * Math.sin(t * 1.3 + e.ph)), t, 0.05);
      e.ld.gain.setTargetAtTime((p.racing ? 0.62 : 0.42) * lo + 0.06, t, 0.08);
    });
    sy.sub.frequency.setTargetAtTime(crank * 2, t, 0.05);
    const gateAvg = sy.oscs.reduce((a, e) => a + e.gate, 0) / sy.oscs.length;
    sy.sg.gain.setTargetAtTime((p.racing ? 0.24 : 0.16) * (1 + 0.6 * load) * (1 - 0.45 * Math.min(r, 1)) * gateAvg, t, 0.08);
    sy.muffle.frequency.setTargetAtTime((300 + r * 2600) * p.tone * (0.8 + 0.35 * load), t, 0.06);
    sy.relief.gain.setTargetAtTime((p.racing ? 0.17 * lo : 0) + 0.09 + 0.13 * r + 0.08 * load, t, 0.08);
    sy.bg.gain.setTargetAtTime(p.thru ? 0 : 0.035 * lo * Math.sqrt(sy.n), t, 0.1);
    sy.ed.gain.setTargetAtTime(p.thru ? 0 : 0.5 * lo, t, 0.1);
    sy.ig.gain.setTargetAtTime(0.015 + 0.12 * load * r, t, 0.08);
    sy.ibp.frequency.setTargetAtTime(800 + r * 900, t, 0.1);
    sy.gw.frequency.setTargetAtTime(rpm * 0.21 * pitchMul, t, 0.06);
    sy.gg.gain.setTargetAtTime(0.003 + 0.01 * r * r, t, 0.08);
    if (sy.wh) {
      sy.wh.o.frequency.setTargetAtTime((rpm / 60) * 27 * pitchMul, t, 0.06);
      sy.wh.o2.frequency.setTargetAtTime((rpm / 60) * 27 * pitchMul * 1.0015, t, 0.06);
      const mulAvg = sy.oscs.reduce((a, e) => a + e.gate * e.mul, 0) / sy.oscs.length;
      sy.wh.g.gain.setTargetAtTime(p.whine * (p.racing ? 0.0075 + 0.024 * r * r : 0.018 * r * r) * mulAvg, t, 0.08);
    }
    sy.out.gain.setTargetAtTime(ENGINE_VOL * vol * p.vol * (0.36 + 0.45 * r + 0.3 * load) * (1 + 0.12 * (sy.n - 1)), t, 0.07);
  }

  function audLoop(type: BiquadFilterType, freq: number, q: number, gain: number): NoiseLoop {
    const c = ctx!;
    const s = audNoiseSrc();
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7;
    const g = c.createGain(); g.gain.value = gain || 0;
    s.connect(f); f.connect(g); g.connect(requireBus());
    return { f, g };
  }

  interface BurstOpts {
    dur?: number; gain?: number; att?: number;
    pos?: [number, number, number]; ref?: number;
    tone?: number; toneTo?: number; wave?: OscillatorType;
    type?: BiquadFilterType; freq?: number; freqTo?: number; q?: number;
  }

  /** legacy `audBurst` (index.html:3108-3116) — a short noise or tone one-shot, optionally in 3D. */
  function audBurst(o: BurstOpts): void {
    if (!ready || !on || !ctx) return;
    const c = ctx;
    const t = c.currentTime, dur = o.dur ?? 0.3;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain ?? 0.4, t + (o.att ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (o.pos) {
      const p = audPanner(); p.refDistance = o.ref ?? 6;
      audPos(p, o.pos[0], o.pos[1], o.pos[2]);
      g.connect(p);
      setTimeout(() => { try { p.disconnect(); } catch { /* already gone */ } }, (dur + 0.2) * 1000);
    } else {
      g.connect(requireBus());
    }
    if (o.tone !== undefined) {
      const src = c.createOscillator();
      src.type = o.wave ?? 'sine';
      src.frequency.setValueAtTime(o.tone, t);
      if (o.toneTo) src.frequency.exponentialRampToValueAtTime(o.toneTo, t + dur);
      src.connect(g);
      src.start(t); src.stop(t + dur + 0.05);
    } else {
      const src = c.createBufferSource(); src.buffer = noise;
      const f = c.createBiquadFilter(); f.type = o.type ?? 'lowpass';
      f.frequency.setValueAtTime(o.freq ?? 800, t);
      if (o.freqTo) f.frequency.exponentialRampToValueAtTime(o.freqTo, t + dur);
      f.Q.value = o.q ?? 0.8;
      src.connect(f); f.connect(g);
      src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  /** legacy `AUD.init` (index.html:3117-3135) — must run from a user gesture (click/keydown). */
  function init(): void {
    if (ctx) { void ctx.resume(); return; }
    const AC = window.AudioContext ?? webkitAudioContextCtor();
    if (!AC) return;
    const c = new AC();
    ctx = c;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master = c.createGain(); master.gain.value = on ? 0.8 : 0;
    comp.connect(master); master.connect(c.destination);
    bus = c.createGain();
    underwaterFilter = c.createBiquadFilter();
    underwaterFilter.type = 'lowpass';
    underwaterFilter.frequency.value = 20000; // wide open at the surface — see audio/underwater.ts
    underwaterFilter.Q.value = 0.4;
    bus.connect(underwaterFilter); underwaterFilter.connect(comp);
    underwaterBus = c.createGain(); underwaterBus.gain.value = 0; underwaterBus.connect(comp);

    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w;
      d[i] = w * 0.6 + b * 2.5;
    }
    noise = buf;

    rush = audLoop('lowpass', 650, 0.6, 0);
    hiss = audLoop('highpass', 3200, 0.5, 0);
    wind = audLoop('bandpass', 550, 0.4, 0);
    wash = audLoop('lowpass', 380, 0.5, 0);

    // reel: drag scream and crank ratchet (an amplitude-chopped high tone)
    const tone = c.createOscillator(); tone.type = 'square'; tone.frequency.value = 2700;
    const chop = c.createGain(); chop.gain.value = 0;
    const lfo = c.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 30;
    const depth = c.createGain(); depth.gain.value = 0;
    lfo.connect(depth); depth.connect(chop.gain);
    const rbp = c.createBiquadFilter(); rbp.type = 'bandpass'; rbp.frequency.value = 2600; rbp.Q.value = 3;
    tone.connect(chop); chop.connect(rbp); rbp.connect(bus);
    tone.start(); lfo.start();
    reel = { tone, lfo, depth };

    ready = true;
    setPlayerBoat({ id: playerBoatId, engines: 2 });
  }

  /** legacy `AUD.setPlayer` (index.html:3136). */
  function setPlayerBoat(spec: Pick<Boat, 'id' | 'engines'>): void {
    if (!ready) { playerBoatId = spec.id; return; }
    if (player) player.dispose();
    playerBoatId = spec.id;
    player = makeEngineSynth(engineProfileFor(spec.id), spec.engines, false);
    startEngines();
  }

  /** legacy `AUD.startEngines` (index.html:3138-3141). */
  function startEngines(): void {
    if (!ready || !player) return;
    const c = ctx!;
    const now = c.currentTime;
    engineOn.v = true; engineOn.startT = now + 0.4;
    player.oscs.forEach((e, i) => {
      e.gate = 0; e.mul = 1;
      const st = engineOn.startT + i * 1.1;
      setTimeout(() => {
        if (!on) return;
        audBurst({ type: 'bandpass', freq: 420, q: 2, dur: 0.75, gain: 0.035, att: 0.05 });
        audBurst({ tone: 150, toneTo: 210, wave: 'square', dur: 0.7, gain: 0.01, att: 0.05 });
      }, Math.max(0, (st - 0.7 - now) * 1000));
      e.startAt = st;
    });
  }

  /** legacy `AUD.stopEngines` (index.html:3142). */
  function stopEngines(): void {
    engineOn.v = false;
    player?.oscs.forEach((e) => { e.gate = 0; e.startAt = null; });
  }

  /** legacy `AUD.toggle` (index.html:3143) — UI label/toast are the caller's job (see audio/index.ts). */
  function toggleMute(): boolean {
    on = !on;
    master?.gain.setTargetAtTime(on ? 0.8 : 0, ctx?.currentTime ?? 0, 0.05);
    return on;
  }

  function isMuted(): boolean { return !on; }
  function isReady(): boolean { return ready; }
  function audioContext(): AudioContext | null { return ctx; }
  function masterBus(): GainNode | null { return bus; }

  /** legacy `AUD.splash` (index.html:3144-3146). */
  function splash(x: number, z: number, size: number, listenerX: number, listenerZ: number): void {
    if (!ready) return;
    const now = performance.now();
    if (now - lastSplash < 45) return;
    const d = Math.hypot(x - listenerX, z - listenerZ);
    if (d > 140) return;
    lastSplash = now;
    audBurst({ dur: 0.25 + size * 0.35, freq: 700 + size * 600, freqTo: 260, gain: Math.min(0.9, 0.25 + size * 0.4), pos: [x, 0.2, z], ref: 5 + size * 6 });
  }

  /** legacy `AUD.slam` (index.html:3147). */
  function slam(k: number): void {
    audBurst({ tone: 75, toneTo: 38, dur: 0.4, gain: 0.9 * k, wave: 'sine' });
    audBurst({ freq: 520, freqTo: 140, dur: 0.5, gain: 0.7 * k });
    audBurst({ type: 'highpass', freq: 2500, dur: 0.6, gain: 0.25 * k, att: 0.03 });
  }

  /** legacy `AUD.cast` (index.html:3148). */
  function cast(p: number): void {
    audBurst({ type: 'bandpass', freq: 350, freqTo: 2400, q: 1.4, dur: 0.35 + p * 0.25, gain: 0.3 });
    audBurst({ tone: 1900 + p * 900, toneTo: 900, wave: 'triangle', dur: 0.6 + p * 0.8, gain: 0.04, att: 0.05 });
  }

  /** legacy `AUD.nibble`/`strike`/`snap`/`land` (index.html:3149-3152) — positional variants take
   * the bobber position; the non-positional ones fire centred on the listener. */
  function nibble(bobX: number, bobZ: number): void {
    audBurst({ freq: 900, dur: 0.08, gain: 0.12, pos: [bobX, 0.1, bobZ] });
  }
  function strike(bobX: number, bobZ: number): void {
    audBurst({ tone: 320, toneTo: 110, dur: 0.18, gain: 0.3, pos: [bobX, 0.1, bobZ] });
    audBurst({ freq: 1100, freqTo: 300, dur: 0.4, gain: 0.6, pos: [bobX, 0.1, bobZ] });
  }
  function snap(): void {
    audBurst({ type: 'highpass', freq: 2600, dur: 0.09, gain: 0.8 });
    audBurst({ tone: 1400, toneTo: 500, wave: 'triangle', dur: 0.12, gain: 0.2 });
  }
  function land(): void {
    audBurst({ tone: 784, dur: 0.35, gain: 0.12 });
    setTimeout(() => audBurst({ tone: 1175, dur: 0.5, gain: 0.1 }), 110);
  }

  /** legacy `caelenSquawk` (index.html:3715-3719) — Caelen's non-positional squawk (always close
   * enough to the boat to skip HRTF panning, unlike the hotspot gull calls below). */
  function caelenSquawk(): void {
    if (!ready || !on || !ctx) return;
    const c = ctx, t0 = c.currentTime;
    ([0, 0.28, 0.5] as const).forEach((d, k) => {
      const t = t0 + d;
      const o = c.createOscillator(), o2 = c.createOscillator(), bp = c.createBiquadFilter(), g = c.createGain();
      o.type = 'sawtooth'; o2.type = 'square';
      const f0 = k === 2 ? 1500 : 1750;
      o.frequency.setValueAtTime(f0 * 0.75, t);
      o.frequency.linearRampToValueAtTime(f0, t + 0.05);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.22);
      o2.frequency.value = f0 * 0.5;
      bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 2.5;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
      o.connect(bp); o2.connect(bp); bp.connect(g); g.connect(requireBus());
      o.start(t); o2.start(t); o.stop(t + 0.26); o2.stop(t + 0.26);
    });
  }

  /** legacy `AUD.gull` (index.html:3153-3157). */
  function gull(x: number, z: number): void {
    if (!ctx) return;
    const c = ctx, t = c.currentTime;
    const o = c.createOscillator(), v = c.createOscillator(), vg = c.createGain(), g = c.createGain();
    const p = audPanner(); p.refDistance = 10;
    audPos(p, x, 14, z);
    o.type = 'triangle';
    o.frequency.setValueAtTime(1350, t);
    o.frequency.exponentialRampToValueAtTime(1750, t + 0.08);
    o.frequency.exponentialRampToValueAtTime(1050, t + 0.45);
    v.frequency.value = 22; vg.gain.value = 60; v.connect(vg); vg.connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(p);
    o.start(t); v.start(t); o.stop(t + 0.55); v.stop(t + 0.55);
    setTimeout(() => { try { p.disconnect(); } catch { /* already gone */ } }, 800);
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame update (legacy `AUD.update`, index.html:3158-3215)
  // -------------------------------------------------------------------------------------------

  function updateListener(l: ListenerPose): void {
    const c = ctx!;
    const L = c.listener, now = c.currentTime;
    L.positionX.setTargetAtTime(l.x, now, 0.03); L.positionY.setTargetAtTime(l.y, now, 0.03); L.positionZ.setTargetAtTime(l.z, now, 0.03);
    L.forwardX.setTargetAtTime(l.fx, now, 0.03); L.forwardY.setTargetAtTime(l.fy, now, 0.03); L.forwardZ.setTargetAtTime(l.fz, now, 0.03);
    L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
  }

  function updatePlayerEngine(dt: number, input: PlayerEngineInputs): void {
    if (!player) return;
    const c = ctx!;
    const pr = player.prof;
    const f = Math.min(1, Math.abs(input.speed) / Math.max(0.01, input.topMs));
    const thr = Math.abs(input.throttle);
    let target = pr.idle + (pr.max - pr.idle) * clamp(thr * 0.82 + f * 0.25 + (input.trimV - 0.4) * 0.08 * thr + input.trimVent * 0.22, 0, 1.1);
    if (input.throttle < 0) target = pr.idle + (pr.max - pr.idle) * 0.25 * (thr / 0.35);
    if (input.gearRev > 0.01) target = Math.max(target, pr.idle + (pr.max - pr.idle) * 0.72 * input.gearRev);
    if (input.ventilating) target = Math.min(pr.max * 1.12, target * 1.18);

    const now = c.currentTime;
    player.oscs.forEach((e) => {
      if (!engineOn.v) { e.gate = 0; return; }
      if (e.startAt == null) { e.gate = 1; e.mul = 1; return; }
      const dtS = now - e.startAt;
      if (dtS < 0) { e.gate = 0; } else {
        e.gate = Math.min(1, dtS * 6);
        e.mul = 1 + 1.15 * Math.exp(-dtS * 2.4) * Math.min(1, dtS * 8);
        if (dtS > 4) { e.startAt = null; e.mul = 1; }
      }
    });

    player.rpm += (target - player.rpm) * Math.min(1, dt * (target > player.rpm ? 2.6 : 1.6));
    if (prevThr > 0.6 && thr < 0.15 && player.rpm > pr.max * 0.55 && on) {
      for (let k = 0; k < 7; k++) {
        setTimeout(() => audBurst({ type: 'bandpass', freq: rand(900, 2200), q: 1.3, dur: 0.05, gain: rand(0.15, 0.32) }), rand(40, 900));
      }
    }
    prevThr = thr;
    const load = clamp(thr - f * 0.7 + 0.25, 0, 1) * (input.ventilating ? 0.2 : 1);
    setEngine(player, player.rpm, load, input.running ? 1 : 0.6, 1);
  }

  function updateAmbience(dt: number, t: number, input: PlayerEngineInputs, sw: number, ch: number): void {
    if (!rush || !hiss || !wind || !wash || !ctx) return;
    const now = ctx.currentTime;
    const f = Math.min(1, Math.abs(input.speed) / Math.max(0.01, input.topMs));
    const sea = Math.min(Math.max(sw * 1.1, ch), 2.5);
    rush.g.gain.setTargetAtTime(input.ventilating ? 0.02 : 0.04 + f * 0.32, now, 0.08);
    rush.f.frequency.setTargetAtTime(400 + f * 900, now, 0.1);
    hiss.g.gain.setTargetAtTime(input.ventilating ? 0 : f * f * 0.12, now, 0.08);
    wind.g.gain.setTargetAtTime(0.015 + f * 0.09 + sea * 0.015, now, 0.2);
    wind.f.frequency.setTargetAtTime(400 + f * 700, now, 0.2);
    wash.g.gain.setTargetAtTime((0.05 + 0.05 * sea) * (0.6 + 0.4 * Math.sin(t * 0.7) * Math.sin(t * 0.31)), now, 0.3);
    if (f < 0.15 && Math.random() < dt * (0.6 + sea * 0.8)) audBurst({ freq: 300, freqTo: 120, dur: 0.25, gain: 0.08 + sea * 0.05, att: 0.02 });
  }

  function updateReel(reelState: ReelAudioState | undefined): void {
    if (!reel || !ctx) return;
    const now = ctx.currentTime;
    let rate = 0, rg = 0, pitch = 2700;
    const m = reelState?.mode ?? 'idle';
    const drag = reelState?.drag ?? 0;
    if (m === 'fightRunning') { rate = 55; rg = 0.02 + 0.01 * drag; pitch = 3100; }
    else if (m === 'fightHeld') { rate = 40 + drag * 30; rg = 0.025 + 0.012 * drag; }
    else if (m === 'reelingNoTension') { rate = 14; rg = 0.012; pitch = 1900; }
    reel.lfo.frequency.setTargetAtTime(Math.max(1, rate), now, 0.03);
    reel.tone.frequency.setTargetAtTime(pitch, now, 0.05);
    reel.depth.gain.setTargetAtTime(rg, now, 0.03);
  }

  function remoteSynthFor(src: RemoteEngineSource): EngineSynth {
    let sy = remoteSynths.get(src.id);
    if (!sy) { sy = makeEngineSynth(engineProfileFor(src.engineProfile), src.engineCount, true); remoteSynths.set(src.id, sy); }
    return sy;
  }

  /** legacy's buddy-motor section (index.html:3190-3192). */
  function updateBuddy(buddy: RemoteEngineSource | undefined, lx: number, lz: number): void {
    if (!buddy) {
      // nothing to do — any previously-built buddy synth is torn down the next time a real
      // `buddy` object disappears entirely (handled by the caller dropping the reference; see
      // audio/index.ts, which disposes remote synths whose id no longer appears in any list).
      return;
    }
    const d = Math.hypot(buddy.x - lx, buddy.z - lz);
    const near = remoteSynths.has(buddy.id);
    if (d < 700 && !near) remoteSynths.set(buddy.id, makeEngineSynth(engineProfileFor(buddy.engineProfile), buddy.engineCount, true));
    else if (d > 950 && near) { remoteSynths.get(buddy.id)?.dispose(); remoteSynths.delete(buddy.id); }
    const sy = remoteSynths.get(buddy.id);
    if (sy) {
      const pr = sy.prof;
      const fr = clamp(Math.abs(buddy.speed) / (buddy.topMs ?? 30), 0, 1);
      audPos(sy.panner!, buddy.x, 1.2, buddy.z);
      setEngine(sy, pr.idle + (pr.max - pr.idle) * fr * 0.9, fr * 0.6, 0.35, 1);
    }
  }

  /** legacy's traffic-engine section (index.html:3194-3199): only boats within earshot get a voice. */
  function updateTraffic(traffic: readonly RemoteEngineSource[] | undefined, dt: number, lx: number, lz: number): void {
    if (!traffic) return;
    for (const r of traffic) {
      const x = r.x, z = r.z, d = Math.hypot(x - lx, z - lz);
      const has = remoteSynths.has(r.id);
      if (d < 650 && !has) remoteSynths.set(r.id, makeEngineSynth(engineProfileFor(r.engineProfile), r.engineCount, true));
      else if (d > 900 && has) { remoteSynths.get(r.id)?.dispose(); remoteSynths.delete(r.id); }
      const sy = remoteSynths.get(r.id);
      if (sy) {
        const prev = remotePrev.get(r.id);
        if (prev) {
          const vx = (x - prev.x) / dt, vz = (z - prev.z) / dt;
          const ux = (lx - x) / (d || 1), uz = (lz - z) / (d || 1);
          const vr = clamp(vx * ux + vz * uz, -60, 60);
          audPos(sy.panner!, x, 1.2, z);
          setEngine(sy, sy.prof.idle + (sy.prof.max - sy.prof.idle) * 0.75, 0.6, 1, clamp(343 / (343 - vr), 0.85, 1.18));
        }
      }
      remotePrev.set(r.id, { x, z });
    }
  }

  /** legacy's go-fast-boats-with-doppler section (index.html:3201-3208). */
  function updateRacers(racers: readonly RemoteEngineSource[] | undefined, dt: number, t: number, lx: number, lz: number, listenerVx: number, listenerVz: number): void {
    if (!racers) return;
    for (const r of racers) {
      const sy = remoteSynthFor(r);
      const x = r.x, z = r.z, d = Math.hypot(x - lx, z - lz);
      const prev = remotePrev.get(r.id);
      if (prev && d < 1400) {
        const vx = (x - prev.x) / dt, vz = (z - prev.z) / dt;
        const ux = (lx - x) / (d || 1), uz = (lz - z) / (d || 1);
        const vr = clamp(vx * ux + vz * uz - (listenerVx * ux + listenerVz * uz), -90, 90);
        audPos(sy.panner!, x, 1.5, z);
        setEngine(sy, sy.prof.max * 0.86 + Math.sin(t * 0.5 + x * 0.001) * 120, 0.8, r.audible !== false ? 1 : 0, clamp(343 / (343 - vr), 0.8, 1.25));
      } else {
        setEngine(sy, sy.prof.idle, 0, 0, 1);
      }
      remotePrev.set(r.id, { x, z });
    }
  }

  /** legacy's friends'-boats section (index.html:3210-3212) — multiplayer ghosts. */
  function updateGhosts(ghosts: readonly RemoteEngineSource[] | undefined, dt: number): void {
    if (!ghosts) return;
    for (const g of ghosts) {
      const sy = remoteSynthFor(g);
      const prev = remotePrev.get(g.id);
      const sp = prev ? Math.hypot(g.x - prev.x, g.z - prev.z) / dt : 0;
      const prVs = remoteGhostVs.get(g.id) ?? 0;
      const vs = lerp(prVs, sp, Math.min(1, dt * 2));
      remoteGhostVs.set(g.id, vs);
      const pr = sy.prof;
      const fr = clamp(vs / 35, 0, 1);
      audPos(sy.panner!, g.x, 1.5, g.z);
      setEngine(sy, pr.idle + (pr.max - pr.idle) * fr, fr * 0.7, 1, 1);
      remotePrev.set(g.id, { x: g.x, z: g.z });
    }
  }

  function updateGulls(dt: number, sites: readonly GullSite[] | undefined, lx: number, lz: number): void {
    gullT -= dt;
    if (gullT > 0) return;
    gullT = rand(0.8, 2.2);
    if (!sites || sites.length === 0) return;
    let best: GullSite | null = null, bd = 170;
    for (const h of sites) {
      const d = Math.hypot(h.x - lx, h.z - lz);
      if (d < bd) { bd = d; best = h; }
    }
    if (best) gull(best.x + rand(-10, 10), best.z + rand(-10, 10));
  }

  /** Drop any remote-engine bookkeeping whose id wasn't present in this frame's
   * traffic/racer/buddy/ghost lists at all (as opposed to merely far away, which `updateTraffic`
   * already disposes) — e.g. a traffic boat that's been despawned/recycled. Call once per frame
   * after the update sections above with the full set of ids that are still "live" this frame. */
  function pruneRemoteSynths(liveIds: ReadonlySet<string>): void {
    for (const [id, sy] of remoteSynths) {
      if (!liveIds.has(id)) { sy.dispose(); remoteSynths.delete(id); }
    }
    for (const id of remotePrev.keys()) if (!liveIds.has(id)) remotePrev.delete(id);
    for (const id of remoteGhostVs.keys()) if (!liveIds.has(id)) remoteGhostVs.delete(id);
  }

  /** legacy `AUD.update` (index.html:3158-3215). */
  function update(input: AudioFrameInputs): void {
    if (!ready) return;
    updateListener(input.listener);
    updatePlayerEngine(input.dt, input.player);
    updateAmbience(input.dt, input.t, input.player, input.sw, input.ch);
    updateReel(input.reel);
    updateBuddy(input.buddy, input.listener.x, input.listener.z);
    updateTraffic(input.traffic, input.dt, input.listener.x, input.listener.z);
    // Racers need the listener's own velocity to do a full doppler subtraction (legacy subtracted
    // the player boat's forward velocity component); derive it from consecutive listener positions.
    const lvx = prevListener ? (input.listener.x - prevListener.x) / input.dt : 0;
    const lvz = prevListener ? (input.listener.z - prevListener.z) / input.dt : 0;
    prevListener = { x: input.listener.x, z: input.listener.z };
    updateRacers(input.racers, input.dt, input.t, input.listener.x, input.listener.z, lvx, lvz);
    updateGhosts(input.ghosts, input.dt);
    updateGulls(input.dt, input.gullSites, input.listener.x, input.listener.z);

    const liveIds = new Set<string>();
    if (input.buddy) liveIds.add(input.buddy.id);
    input.traffic?.forEach((r) => liveIds.add(r.id));
    input.racers?.forEach((r) => liveIds.add(r.id));
    input.ghosts?.forEach((r) => liveIds.add(r.id));
    pruneRemoteSynths(liveIds);
  }

  /** legacy's `document.addEventListener('visibilitychange', ...)` (index.html:3216) — suspend
   * the whole context in a backgrounded tab, resume it (if sound is on) when it comes back. */
  function bindVisibilitySuspend(doc: Document = document): () => void {
    const handler = (): void => {
      if (!ctx) return;
      if (doc.hidden) void ctx.suspend();
      else if (on) void ctx.resume();
    };
    doc.addEventListener('visibilitychange', handler);
    return () => doc.removeEventListener('visibilitychange', handler);
  }

  function dispose(): void {
    player?.dispose();
    for (const sy of remoteSynths.values()) sy.dispose();
    remoteSynths.clear();
    try { ctx?.close(); } catch { /* already closed */ }
  }

  return {
    init, setPlayerBoat, startEngines, stopEngines, toggleMute, isMuted, isReady, audioContext, masterBus,
    splash, slam, cast, nibble, strike, snap, land, gull, caelenSquawk,
    update, bindVisibilitySuspend, dispose,
    /** Exposed for `music/radio.ts`, which needs to patch into the same `bus`/compressor chain and
     * read `ready`/`on` without this module exporting its whole closure. */
    _internal: {
      get ctx() { return ctx; },
      get bus() { return bus; },
      get ready() { return ready; },
      get on() { return on; },
      get underwaterFilter() { return underwaterFilter; },
      get underwaterBus() { return underwaterBus; },
    },
  };
}

export type AudioEngine = ReturnType<typeof createAudioEngine>;
