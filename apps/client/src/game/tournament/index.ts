/**
 * Tournament mode: the 🏆 button, the HUD, the opening titles, the AI fleet in the harbour, the
 * drop-off, and the ceremony — the glue between a `TourneyLink` (link.ts: this machine offline,
 * the sim server online) and the rules in @keysrun/shared/sim/tournament.
 *
 * Like race mode it is built once and costs nothing while no tournament is running: `update`
 * returns after one null check.
 *
 * What counts as a catch is a fish you *keep* (game/catch/catch-flow.ts's keep path calls
 * `onKeep`): you have to bring them in, and a released fish isn't in your cooler. The species are
 * drawn so that all five can legally be kept (sim/tournament.ts TOURNEY_POOL).
 *
 * The camera: during the countdown (the opening titles) and the ceremony, `cameraShot` returns the
 * shot and game/world.ts puts the camera there after its own camera update. Both are skippable —
 * the intro with its Skip button or Esc; the ceremony is ten seconds and isn't.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import {
  ALL_CAUGHT, HARBOUR, TOURNEY_COUNTDOWN_S, TOURNEY_NPCS,
  countCaught, inHarbour, isNpcId, npcEntry, phaseOf, standings, timeLeft,
  type Tourney, type TourneyPhase,
} from '@keysrun/shared/sim/tournament';
import { readSave, writeSave } from '../../net/cloud-save.js';
import type { ParticleSystem } from '../../world/particles.js';
import { createLocalLink, type TourneyLink } from './link.js';
import { createTourneyFleet } from './fleet.js';
import { createCeremony, type Shot } from './ceremony.js';
import { planIntro, type IntroCard, type IntroEntrant, type IntroPlan } from './intro.js';

export interface TourneyDeps {
  scene: THREE.Scene;
  wrap: HTMLElement;
  particles: ParticleSystem | null;
  toast(msg: string): void;
  /** Your boat, and what to call it on your intro card. */
  getBoat(): { x: number; z: number; h: number; speed: number; label: string };
  /** Other players' boats, as the minimap has them. */
  getRemotes(): ReadonlyArray<{ slotId?: number; x: number; z: number; h: number }>;
  /** Freshly built scenery (ceremony) — for the shadow setup, as the dock celebration does. */
  onBuilt(root: THREE.Object3D): void;
}

/** Trophies won, kept with the rest of the game (net/cloud-save.ts CLOUD_KEYS). */
export const TROPHY_KEY = 'keysrun.trophies.v1';
interface TrophyCase { wins: Array<{ at: string; species: string[]; weights: number[]; online: boolean }> }

function readTrophies(): TrophyCase {
  try { const v = JSON.parse(readSave(TROPHY_KEY) ?? ''); if (Array.isArray(v?.wins)) return v; } catch { /* none yet */ }
  return { wins: [] };
}

const fmtClock = (s: number): string => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function createTournamentMode(deps: TourneyDeps) {
  let link: TourneyLink = createLocalLink();
  const fleet = createTourneyFleet();
  deps.scene.add(fleet.group);
  const ceremony = createCeremony({ scene: deps.scene, onBuilt: deps.onBuilt });

  // --- DOM: the HUD, and the letterboxed title overlay -------------------
  const hud = document.createElement('div');
  hud.className = 'raceHud tourneyHud';
  hud.setAttribute('aria-live', 'polite');
  hud.style.display = 'none';
  deps.wrap.appendChild(hud);

  const cine = document.createElement('div');
  cine.className = 'tourneyCine';
  cine.style.display = 'none';
  cine.innerHTML = '<div class="tcBar top"></div><div class="tcBar bot"></div><div class="tcCard"></div><button class="tcSkip" type="button">Skip ▸</button>';
  deps.wrap.appendChild(cine);
  const cineCard = cine.querySelector('.tcCard') as HTMLElement;
  let cardKey = '';

  // --- per-tournament memory, keyed by seed so a new one starts clean ----
  let seed = -1;
  let lastPhase: TourneyPhase | null = null;
  let skippedIntro = false;
  let announcedAll = false;
  let ceremonyFor = -1;
  let awardedFor = -1;
  let seenMasks = new Map<string, number>();
  let intro: IntroPlan | null = null;
  let introEntrants = '';
  let hudAt = -Infinity;

  function skipIntro(): void { skippedIntro = true; }
  cine.querySelector('.tcSkip')?.addEventListener('click', skipIntro);
  window.addEventListener('keydown', (e) => { if (e.code === 'Escape' && cine.style.display !== 'none') skipIntro(); });

  function reset(t: Tourney): void {
    seed = t.seed;
    lastPhase = null;
    skippedIntro = false;
    announcedAll = false;
    seenMasks = new Map();
    intro = null;
    introEntrants = '';
  }

  function mine(t: Tourney): number {
    return t.entries.find((e) => e.id === link.selfId())?.mask ?? 0;
  }

  // --- the opening titles ------------------------------------------------
  function entrants(t: Tourney): IntroEntrant[] {
    const out: IntroEntrant[] = TOURNEY_NPCS.map((n, i) => ({
      name: n.captain, boat: n.boat,
      pose: () => { const b = fleet.boats[i]; return { x: b.x, z: b.z, h: b.heading }; },
    }));
    const me = deps.getBoat();
    out.push({ name: link.nameOf(link.selfId()), boat: me.label, pose: () => { const b = deps.getBoat(); return { x: b.x, z: b.z, h: b.h }; } });
    for (const e of t.entries) {
      if (e.id === link.selfId()) continue;
      const slot = Number(e.id.slice(1));
      out.push({
        name: link.nameOf(e.id), boat: 'In the field',
        pose: () => { const r = deps.getRemotes().find((x) => x.slotId === slot); return r ? { x: r.x, z: r.z, h: r.h } : null; },
      });
    }
    return out;
  }

  function fleetCentre(): { x: number; z: number; h: number } {
    const b = fleet.boats[Math.floor(fleet.boats.length / 2)];
    return { x: b.x, z: b.z, h: b.heading };
  }

  function renderCard(card: IntroCard, key: string): void {
    if (key === cardKey) return;
    cardKey = key;
    cineCard.className = `tcCard ${card.kind}`;
    cineCard.innerHTML = card.kind === 'title'
      ? `<div class="tcKicker">Boot Key Harbor</div><div class="tcTitle">${esc(card.title)}</div><div class="tcSub">${esc(card.sub)}</div><div class="tcChips">${(card.chips ?? []).map((c) => `<span>${esc(c)}</span>`).join('')}</div>`
      : card.kind === 'gun'
        ? `<div class="tcTitle">${esc(card.title)}</div><div class="tcSub">${esc(card.sub)}</div>`
        : `<div class="tcName">${esc(card.title)}</div><div class="tcSub">${esc(card.sub)}</div>`;
    // Restart the card's entrance animation on every cut.
    cineCard.style.animation = 'none';
    void cineCard.offsetWidth;
    cineCard.style.animation = '';
  }

  // --- HUD ---------------------------------------------------------------
  function renderHud(t: Tourney, now: number): void {
    const phase = phaseOf(t, now);
    const my = mine(t);
    const self = link.selfId();
    const species = t.species.map((k, i) => `<li class="${(my >> i) & 1 ? 'got' : ''}">${(my >> i) & 1 ? '✓' : '○'} ${esc(SPECIES[k].name)}</li>`).join('');
    const rows = standings(t, now).map((r) => {
      const name = r.id === self ? 'You' : link.nameOf(r.id);
      const state = r.won ? '🏆' : r.home ? 'in' : `${r.caught}/5`;
      return `<li${r.id === self ? ' class="me"' : ''}>${esc(name)}<span>${state}</span></li>`;
    }).join('');

    let top = '';
    if (phase === 'countdown') top = `<div class="raceBig">${Math.max(1, Math.ceil(t.t0 - now))}</div><div class="raceSub">Tournament — lines in soon</div>`;
    else if (phase === 'live') {
      const b = deps.getBoat();
      const d = Math.hypot(b.x - HARBOUR.x, b.z - HARBOUR.z);
      const next = my === ALL_CAUGHT
        ? `<div class="raceNext tAll">All five! Run them in: ${HARBOUR.name} ${d > 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}${d < HARBOUR.r ? ' — slow down to tie up' : ''}</div>`
        : `<div class="raceNext">${countCaught(my)}/5 — keep one of each</div>`;
      top = `<div class="raceTop"><span class="racePlace">🏆</span><span class="raceClock">${fmtClock(timeLeft(t, now))}</span></div>${next}`;
    } else if (phase === 'ceremony') top = `<div class="raceSub">🏆 ${esc(t.winner!.id === self ? 'You win!' : `${link.nameOf(t.winner!.id)} wins`)}</div>`;
    else top = `<div class="raceSub">${t.winner ? `🏆 ${esc(t.winner.id === self ? 'You won' : `${link.nameOf(t.winner.id)} won`)}` : 'Horn — nobody brought all five in'} · 🏆 to fish another</div>`;

    hud.innerHTML = `${top}<ul class="tSpecies">${species}</ul><ol class="raceBoard">${rows}</ol>`;
  }

  // --- toasts for what happens out there -----------------------------------
  function announceProgress(t: Tourney, now: number): void {
    const ids = [...t.entries.map((e) => e.id), ...TOURNEY_NPCS.map((_, i) => `npc${i}`)];
    for (const id of ids) {
      const mask = isNpcId(id) ? npcEntry(t, Number(id.slice(3)), now).mask : t.entries.find((e) => e.id === id)!.mask;
      const was = seenMasks.get(id);
      seenMasks.set(id, mask);
      // First sight of an entry (joining mid-tournament): take the board as it stands, quietly.
      if (was === undefined || id === link.selfId() || mask === was) continue;
      const newBits = mask & ~was;
      const k = Math.log2(newBits & -newBits);
      if (Number.isInteger(k) && t.species[k]) deps.toast(`${link.nameOf(id)} boated a ${SPECIES[t.species[k]].name} — ${countCaught(mask)}/5.`);
    }
  }

  function award(t: Tourney): void {
    if (awardedFor === t.seed || !t.winner) return;
    awardedFor = t.seed;
    if (t.winner.id !== link.selfId()) return;
    const tc = readTrophies();
    tc.wins.push({ at: new Date().toISOString(), species: [...t.species], weights: [...t.winner.weights], online: link.online });
    try { writeSave(TROPHY_KEY, JSON.stringify(tc)); } catch (e) { console.error('trophy save', e); }
    deps.toast(`You won the tournament! The trophy goes in your case — ${tc.wins.length} so far.`);
  }

  function beginCeremony(t: Tourney): void {
    if (ceremonyFor === t.seed || !t.winner) return;
    ceremonyFor = t.seed;
    const w = t.winner;
    const npc = isNpcId(w.id);
    const ok = ceremony.begin({
      name: link.nameOf(w.id),
      boat: npc ? TOURNEY_NPCS[Number(w.id.slice(3))].boat : w.id === link.selfId() ? deps.getBoat().label : 'Tournament champion',
      species: t.species,
      weights: w.weights,
      captain: npc,
    });
    if (!ok) console.warn('[tournament] no room on the marina planks for the ceremony');
  }

  // --- control -------------------------------------------------------------
  function toggle(): void {
    const t = link.current();
    if (!t || phaseOf(t, link.now()) === 'over') { link.start(); return; }
    if (link.abort) { link.abort(); deps.toast('Tournament abandoned.'); return; }
    deps.toast('The tournament runs for everyone online — it ends at the horn.');
  }

  function onKeep(key: string, weight: number): void {
    const t = link.current();
    if (!t || phaseOf(t, link.now()) !== 'live') return;
    const before = mine(t);
    link.reportCatch(key, weight);
    const after = mine(t);
    if (after === before) return;
    deps.toast(after === ALL_CAUGHT
      ? `${SPECIES[key].name} — that's all five! Run them in to ${HARBOUR.name}.`
      : `Tournament: ${SPECIES[key].name} ✓ — ${countCaught(after)}/5.`);
    if (after === ALL_CAUGHT) announcedAll = true;
  }

  function update(dt: number, t3: number): void {
    link.step();
    const t = link.current();
    if (!t) {
      document.body.classList.remove('tourneyCinematic');
      hud.style.display = 'none';
      cine.style.display = 'none';
      fleet.update(dt, t3, null, deps.particles);
      if (ceremony.active) ceremony.end();
      return;
    }
    if (t.seed !== seed) reset(t);
    const now = link.now();
    const phase = phaseOf(t, now);

    if (phase !== lastPhase) {
      if (phase === 'countdown') deps.toast(`Tournament! Today's five: ${t.species.map((k) => SPECIES[k].name).join(', ')}.`);
      if (phase === 'live' && lastPhase === 'countdown') deps.toast(`Lines in! One of each, then back to ${HARBOUR.name}. First boat in wins.`);
      if (phase === 'ceremony') { beginCeremony(t); award(t); }
      if (phase === 'over') {
        if (lastPhase === 'ceremony') ceremony.end();
        else if (lastPhase === 'live' && !t.winner) deps.toast('Horn! Nobody brought all five in — no trophy this time.');
        else if (t.winner) award(t);
      }
      lastPhase = phase;
    }

    if (phase === 'live') {
      announceProgress(t, now);
      const b = deps.getBoat();
      if (mine(t) === ALL_CAUGHT) {
        if (!announcedAll) { announcedAll = true; deps.toast(`All five on ice — run them in to ${HARBOUR.name}!`); }
        if (inHarbour(b.x, b.z, b.speed)) link.reportDock(b);
      }
    }

    fleet.update(dt, t3, now - t.t0, deps.particles);
    if (ceremony.active) ceremony.update(dt, t3);

    // The opening titles.
    const showIntro = phase === 'countdown' && !skippedIntro;
    cine.style.display = showIntro ? '' : 'none';
    if (showIntro) {
      const ents = entrants(t);
      const sig = ents.map((e) => e.name).join('|');
      if (!intro || sig !== introEntrants) { intro = planIntro(t.species, ents, fleetCentre); introEntrants = sig; }
      const a = intro.at(now - (t.t0 - TOURNEY_COUNTDOWN_S), t3);
      renderCard(a.card, a.cardKey);
    }

    hud.style.display = showIntro ? 'none' : '';
    // The titles and the ceremony are shots, not gameplay: the gauges, chart and prompts go.
    document.body.classList.toggle('tourneyCinematic', showIntro || (phase === 'ceremony' && ceremony.active));
    if (now - hudAt > 0.25) { hudAt = now; renderHud(t, now); }
  }

  /** The camera, when the tournament has it (titles, ceremony); null the rest of the time. */
  function cameraShot(t3: number): Shot | null {
    const t = link.current();
    if (!t) return null;
    const now = link.now();
    const phase = phaseOf(t, now);
    if (phase === 'countdown' && !skippedIntro && intro) return intro.at(now - (t.t0 - TOURNEY_COUNTDOWN_S), t3).shot;
    if (phase === 'ceremony' && ceremony.active && t.winner) return ceremony.shot(now - (t.t0 + t.winner.at));
    return null;
  }

  return {
    setLink(l: TourneyLink): void { link = l; },
    toggle,
    onKeep,
    update,
    cameraShot,
    isActive: (): boolean => { const t = link.current(); return !!t && phaseOf(t, link.now()) !== 'over'; },
    trophies: (): number => readTrophies().wins.length,
    /** Verification only. */
    debug: () => ({ link, tourney: link.current(), now: link.now(), fleet: fleet.boats.map((b) => ({ x: b.x, z: b.z, s: b.s, speed: b.speed })), ceremonySpot: ceremony.spot() }),
  };
}

export type TournamentMode = ReturnType<typeof createTournamentMode>;
