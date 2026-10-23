/**
 * The land office: Keys Run Estates' chart, deeds and build sheets, after the "Keys Run Estates"
 * plat page the lots were drawn up in.
 *
 * Pick a lot on the chart to read its deed: tier, area, frontage, who holds it or what it costs.
 * Buy it from your wallet; then the build sheet chooses what stands on it (residence, dock, the
 * fish hung on the property, trophies, pool, fire pit). The site plan is drawn from the same
 * `siteLayout` the world builds from (entities/estates) and you walk on (entities/land), so what
 * the plan shows is where things are.
 *
 * DOM only; the registry (game/estates/registry.ts) owns the data and re-renders this through its
 * subscription when anything changes, including another player buying a lot while it is open.
 */
import {
  DOCKS, MAX_TROPHIES, MOUNTS, PARCELS, RESIDENCES, TIERS, TIER_ORDER, parcelById, priceOf, siteLayout,
  type Build, type Parcel, type Tier,
} from '@keysrun/shared/content/estates';
import { SPECIES } from '@keysrun/shared/content/species';
import { islands } from '@keysrun/shared/world/chain';
import { TOWN_MARINA } from '@keysrun/shared/world/town';
import type { EstateRegistry, Wallet } from '../../game/estates/registry.js';
import { toast } from '../toast.js';
import './estates.css';

const SVGNS = 'http://www.w3.org/2000/svg';
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const money = (n: number): string => '$' + fmt(n);

const TIER_COLOR: Record<Tier, string> = {
  harbor: '#f2b84b', private: '#e46fa1', point: '#b48cf0', oceanfront: '#4fc3d9',
  bayfront: '#6fcf7f', biscayne: '#5b8def', mainland: '#9aa7b2',
};

/** Chart views: the bounding box of the lots on these islands (or tier), padded. */
const REGIONS: Array<{ label: string; pick(p: Parcel): boolean }> = [
  { label: 'Whole chart', pick: () => true },
  { label: 'Marathon', pick: (p) => ['Marathon (Vaca Key)', 'Boot Key', 'Key Colony Beach', 'Fat Deer Key', 'Crawl Key', 'Grassy Key', "Knight's Key"].includes(p.island) },
  { label: 'Seven Mile', pick: (p) => ['Little Duck Key', 'Pigeon Key', "Knight's Key", 'Molasses Keys'].includes(p.island) },
  { label: 'Biscayne Bay', pick: (p) => p.tier === 'biscayne' || p.tier === 'mainland' || p.tier === 'private' && p.cz < -1500 },
  { label: 'Boot Key', pick: (p) => p.island === 'Boot Key' },
  { label: 'Harbor town', pick: (p) => p.tier === 'harbor' || p.island === 'Boot Key' && Math.hypot(p.cx - TOWN_MARINA.sx, p.cz - TOWN_MARINA.sz) < 500 },
];

function bbox(ps: Parcel[], pad: number): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ps) for (const [x, z] of p.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const w = x1 - x0, h = z1 - z0, m = Math.max(w, h) * pad + 40;
  return [x0 - m, z0 - m, w + 2 * m, h + 2 * m];
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent?.appendChild(e);
  return e;
}
const pts = (poly: Parcel['poly']): string => poly.map(([x, z]) => `${x},${z}`).join(' ');

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Real outlines (closed rings [x0, z0, x1, z1, ...], world metres) as one SVG path. */
function ringsPath(rings: readonly (readonly number[])[]): string {
  return rings.map((r) => {
    let d = '';
    for (let i = 0; i < r.length; i += 2) d += (i ? 'L' : 'M') + Math.round(r[i] * 10) / 10 + ' ' + Math.round(r[i + 1] * 10) / 10;
    return d + 'Z';
  }).join('');
}

export interface EstatesPanelDeps {
  registry: EstateRegistry;
  wallet: Wallet & { subscribe?(f: () => void): () => void };
  /** Where the player is now, for "x km from you" on the deed. */
  playerPos?(): { x: number; z: number } | null;
}

export function mountEstatesPanel(wrap: HTMLElement, deps: EstatesPanelDeps) {
  const { registry, wallet } = deps;

  const openBtn = document.createElement('button');
  openBtn.className = 'krEsOpenBtn';
  openBtn.textContent = '🏝 Estates';
  wrap.appendChild(openBtn);

  const panel = document.createElement('div');
  panel.className = 'krEsPanel hidden';
  panel.innerHTML = `
    <div class="krEsCard" role="dialog" aria-label="Keys Run Estates">
      <header class="krEsHead">
        <div><div class="krEsEyebrow">Keys Run · Land office</div><h2>Keys Run Estates</h2></div>
        <div class="krEsCash" aria-live="polite"></div>
        <button type="button" class="krEsClose" aria-label="Close">✕</button>
      </header>
      <div class="krEsBody">
        <section class="krEsChartCol">
          <div class="krEsRegions" role="group" aria-label="Chart view"></div>
          <div class="krEsChartWrap">
            <svg class="krEsChart" role="img" aria-label="Chart of every lot"></svg>
            <div class="krEsZoom"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button></div>
            <div class="krEsTip hidden"></div>
            <div class="krEsAttrib">Coastlines © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</div>
          </div>
          <div class="krEsLegend"></div>
          <div class="krEsParty"></div>
        </section>
        <section class="krEsDeed" aria-live="polite"></section>
      </div>
    </div>`;
  wrap.appendChild(panel);

  const $ = <T extends Element>(s: string): T => panel.querySelector(s) as T;
  const chart = $<SVGSVGElement>('.krEsChart');
  const deed = $<HTMLElement>('.krEsDeed');
  const tip = $<HTMLElement>('.krEsTip');
  const cashEl = $<HTMLElement>('.krEsCash');

  let selected: string | null = null;
  let tierFilter: Tier | null = null;
  let view = bbox(PARCELS as Parcel[], 0.03);
  const parcelEls = new Map<string, SVGPolygonElement>();

  /* ---------------------------------------------------------------- chart */

  const gLand = svgEl('g', {}, chart);
  const gLots = svgEl('g', {}, chart);
  const gTop = svgEl('g', {}, chart);
  for (const I of islands) {
    if (I.mainland) { svgEl('rect', { x: -7000, y: I.z - I.b * 3, width: 14000, height: I.b * 3 + I.b, class: 'krEsLand' }, gLand); continue; }
    if (I.coast) { svgEl('path', { d: ringsPath(I.coast.rings), 'fill-rule': 'evenodd', class: 'krEsLand' }, gLand); continue; }
    svgEl('ellipse', { cx: I.x, cy: I.z, rx: I.a, ry: I.b, transform: `rotate(${(I.th * 180) / Math.PI} ${I.x} ${I.z})`, class: 'krEsLand' }, gLand);
  }
  for (const p of PARCELS) {
    const e = svgEl('polygon', { points: pts(p.poly), class: 'krEsLot', fill: TIER_COLOR[p.tier], stroke: TIER_COLOR[p.tier], tabindex: 0, 'aria-label': p.name }, gLots);
    e.addEventListener('click', () => select(p.id));
    e.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(p.id); } });
    e.addEventListener('pointerenter', () => {
      const o = registry.owner(p.id);
      tip.innerHTML = `<b>${esc(p.name)}</b><br><span>${TIERS[p.tier].label} · ${fmt(p.area)} m² · ${o ? 'held by ' + esc(o.ownerName) : money(priceOf(p))}</span>`;
      tip.classList.remove('hidden');
    });
    e.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    parcelEls.set(p.id, e);
  }
  chart.addEventListener('pointermove', (ev) => {
    const r = chart.getBoundingClientRect();
    tip.style.left = `${ev.clientX - r.left + 14}px`;
    tip.style.top = `${ev.clientY - r.top + 10}px`;
  });

  function setView(v: [number, number, number, number]): void {
    const relabel = (view[2] < 2500) !== (v[2] < 2500);
    view = v;
    if (relabel) { paintLots(); return; }
    chart.setAttribute('viewBox', v.join(' '));
    // Owner badges and the party ring are sized in screen pixels, whatever the zoom.
    const r = chart.getBoundingClientRect();
    const k = v[2] / Math.max(1, r.width || 600);
    chart.style.setProperty('--k', String(k));
    gTop.querySelectorAll<SVGTextElement>('text').forEach((t) => t.setAttribute('font-size', String(12 * k)));
    gTop.querySelectorAll<SVGCircleElement>('circle').forEach((c) => c.setAttribute('r', String(Math.max(Number(c.dataset.r) || 0, 18 * k))));
  }

  function zoom(f: number, cx = view[0] + view[2] / 2, cz = view[1] + view[3] / 2): void {
    const w = Math.min(14000, Math.max(120, view[2] * f)), h = (view[3] * w) / view[2];
    setView([cx - ((cx - view[0]) * w) / view[2], cz - ((cz - view[1]) * h) / view[3], w, h]);
  }
  chart.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = chart.getBoundingClientRect();
    zoom(ev.deltaY > 0 ? 1.18 : 1 / 1.18, view[0] + ((ev.clientX - r.left) / r.width) * view[2], view[1] + ((ev.clientY - r.top) / r.height) * view[3]);
  }, { passive: false });
  let drag: { x: number; y: number; v: typeof view; moved: boolean } | null = null;
  chart.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, v: view, moved: false }; });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const r = chart.getBoundingClientRect();
    const dx = ((ev.clientX - drag.x) / r.width) * drag.v[2], dz = ((ev.clientY - drag.y) / r.height) * drag.v[3];
    if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) drag.moved = true;
    if (drag.moved) setView([drag.v[0] - dx, drag.v[1] - dz, drag.v[2], drag.v[3]]);
  });
  window.addEventListener('pointerup', () => { drag = null; });
  // A drag that ends over a lot must not also select it.
  chart.addEventListener('click', (ev) => { if (drag?.moved) ev.stopPropagation(); }, true);
  panel.querySelectorAll<HTMLButtonElement>('[data-z]').forEach((b) => { b.onclick = () => zoom(b.dataset.z === 'in' ? 1 / 1.5 : 1.5); });

  const regions = $<HTMLElement>('.krEsRegions');
  REGIONS.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'krEsPill'; b.textContent = r.label;
    b.setAttribute('aria-pressed', String(i === 0));
    b.onclick = () => {
      regions.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      setView(bbox(PARCELS.filter(r.pick) as Parcel[], 0.08));
    };
    regions.appendChild(b);
  });

  function renderLegend(): void {
    const L = $<HTMLElement>('.krEsLegend');
    L.innerHTML = '';
    for (const t of TIER_ORDER) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'krEsPill';
      b.setAttribute('aria-pressed', String(tierFilter === t));
      b.innerHTML = `<span class="krEsSw" style="--c:${TIER_COLOR[t]}"></span>${TIERS[t].label} <span class="krEsMuted">${PARCELS.filter((p) => p.tier === t).length}</span>`;
      b.onclick = () => { tierFilter = tierFilter === t ? null : t; renderLegend(); paintLots(); };
      L.appendChild(b);
    }
  }

  function paintLots(): void {
    const reg = registry.registry;
    gTop.innerHTML = '';
    for (const p of PARCELS) {
      const e = parcelEls.get(p.id)!;
      const o = registry.owner(p.id);
      e.classList.toggle('dim', !!tierFilter && p.tier !== tierFilter);
      e.classList.toggle('held', !!o);
      e.classList.toggle('mine', !!o && registry.isMine(o));
      e.classList.toggle('sel', p.id === selected);
      // Zoomed out, the town's four Harbor Row names would print on top of each other: only your
      // own lots are labelled until the chart is close enough to tell neighbours apart.
      if (o && (registry.isMine(o) || view[2] < 2500)) {
        const t = svgEl('text', { x: p.cx, y: p.cz, class: 'krEsBadge' + (registry.isMine(o) ? ' mine' : '') }, gTop);
        t.textContent = registry.isMine(o) ? 'You' : o.ownerName;
      }
    }
    if (selected) gLots.appendChild(parcelEls.get(selected)!);
    if (reg.party) {
      const p = parcelById(reg.party.parcelId);
      if (p) { const c = svgEl('circle', { cx: p.cx, cy: p.cz, class: 'krEsPartyRing' }, gTop); c.dataset.r = '60'; }
    }
    setView(view);
    const party = $<HTMLElement>('.krEsParty');
    if (reg.party) {
      const p = parcelById(reg.party.parcelId);
      party.innerHTML = `<b>🎉 Party tonight</b> at ${esc(p?.name ?? '')} — ${esc(reg.party.displayName)} is #1 with a ${reg.party.weightLb.toFixed(1)} lb ${esc(SPECIES[reg.party.speciesKey]?.name ?? reg.party.speciesKey)}.`;
    } else {
      party.innerHTML = '<span class="krEsMuted">Whoever tops the leaderboard throws a party at their best estate. Nobody on the board owns land yet.</span>';
    }
  }

  /* ---------------------------------------------------------------- deed + build sheet */

  function choiceButtons<K extends string>(map: Record<K, { label: string; note: string }>, current: K, key: keyof Build): string {
    return `<div class="krEsChoices">${(Object.entries(map) as Array<[K, { label: string; note: string }]>).map(([k, v]) =>
      `<button type="button" class="krEsChoice" data-key="${key}" data-val="${k}" aria-pressed="${k === current}"><b>${v.label}</b><small>${v.note}</small></button>`).join('')}</div>`;
  }

  function select(id: string): void {
    selected = id;
    renderDeed();
    paintLots();
  }

  function renderDeed(): void {
    const p = selected ? parcelById(selected) : undefined;
    if (!p) {
      deed.innerHTML = `<div class="krEsEmpty"><h3>Pick a lot on the chart</h3><p>${PARCELS.length} parcels of buildable shore, from Harbor Row behind the casino to the islands off Miami. Read the deed, buy it, then build: the residence, the dock, the trophies, and the party it throws when you top the leaderboard.</p></div>`;
      return;
    }
    const o = registry.owner(p.id);
    const mine = !!o && registry.isMine(o);
    const T = TIERS[p.tier];
    const party = registry.registry.party?.parcelId === p.id;
    const me = deps.playerPos?.();
    const away = me ? Math.hypot(me.x - p.cx, me.z - p.cz) : null;
    const town = Math.hypot(TOWN_MARINA.sx - p.cx, TOWN_MARINA.sz - p.cz);
    const km = (d: number) => (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`);
    const head = `
      <section class="krEsDeedHead">
        <span class="krEsTier" style="--c:${TIER_COLOR[p.tier]}"><span class="krEsSw" style="--c:${TIER_COLOR[p.tier]}"></span>${T.label}</span>
        <h3>${esc(p.name)}</h3>
        <p class="krEsMuted">${p.island === p.name ? '' : esc(p.island.replace(' (Vaca Key)', '')) + ' · '}${esc(p.side)}. ${T.blurb}</p>
      </section>
      <section>
        ${o ? `<div class="krEsHolder"><span>Held by <b>${mine ? 'you' : esc(o.ownerName)}</b></span><span class="krEsMuted">${o.founding ? 'founding owner' : 'owner'}</span></div>`
            : `<div class="krEsPrice"><b>${money(priceOf(p))}</b><button type="button" class="krEsBuy">Buy this lot</button></div>`}
        <dl class="krEsFacts">
          <div><dt>Area</dt><dd>${fmt(p.area)} m²</dd></div>
          <div><dt>${p.tier === 'private' ? 'Shoreline' : 'Frontage'}</dt><dd>${fmt(p.frontage)} m</dd></div>
          <div><dt>To town</dt><dd>${km(town)}</dd></div>
          ${away !== null ? `<div><dt>From you</dt><dd>${km(away)}</dd></div>` : ''}
        </dl>
        ${party ? `<div class="krEsBanner"><b>#1 on the leaderboard.</b> The party is at this house: lights up, DJ on the deck, the Pink Flamingo crowd comes over, boats raft up at the dock.</div>` : ''}
      </section>`;
    const b = o?.build;
    const sheet = mine && b ? `
      <section class="krEsSheet">
        <div class="krEsEyebrow">Build sheet</div>
        <div class="krEsOpt"><span>Residence</span>${choiceButtons(RESIDENCES, b.res, 'res')}</div>
        ${p.tier === 'harbor' ? '' : `<div class="krEsOpt"><span>Dock</span>${choiceButtons(DOCKS, b.dock, 'dock')}</div>`}
        <div class="krEsOpt"><label for="krEsFish">Biggest catch, hung on the property</label>
          <div class="krEsRow"><select id="krEsFish">${Object.entries(SPECIES).sort((x, y) => y[1].max - x[1].max).map(([k, s]) => `<option value="${k}" ${k === b.fish ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <input id="krEsLb" type="number" min="1" max="${SPECIES[b.fish].max}" value="${b.lb}" aria-label="Weight in pounds"><span class="krEsMuted">lb</span></div>
          <div class="krEsRow"><label for="krEsMount" class="krEsMuted">Hung</label><select id="krEsMount">${(Object.entries(MOUNTS) as Array<[string, string]>).filter(([k]) => k !== 'gallows' || b.dock !== 'none').map(([k, v]) => `<option value="${k}" ${k === b.mount ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="krEsOpt"><label for="krEsTrophies">Trophies around the grounds: <b class="krEsTrN">${b.trophies}</b></label><input id="krEsTrophies" type="range" min="0" max="${MAX_TROPHIES}" value="${b.trophies}"></div>
        <div class="krEsRow"><label class="krEsToggle"><input type="checkbox" id="krEsPool" ${b.pool ? 'checked' : ''}>Pool</label><label class="krEsToggle"><input type="checkbox" id="krEsFire" ${b.firepit ? 'checked' : ''}>Fire pit</label></div>
      </section>` : '';
    deed.innerHTML = head + sheet + `<section><svg class="krEsPlan" role="img" aria-label="Site plan of ${esc(p.name)}"></svg><p class="krEsMuted krEsPlanNote"></p></section>`;
    drawPlan(p, b ?? null, party);

    deed.querySelector<HTMLButtonElement>('.krEsBuy')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true; btn.textContent = 'Signing the deed…';
      const r = await registry.buy(p.id, wallet);
      toast(r.message);
      renderDeed(); paintLots(); paintCash();
    });
    if (!mine) return;
    const save = (patch: Partial<Build>) => { void registry.saveBuild(p.id, patch); };
    deed.querySelectorAll<HTMLButtonElement>('.krEsChoice').forEach((x) => { x.onclick = () => save({ [x.dataset.key!]: x.dataset.val } as Partial<Build>); });
    const fish = deed.querySelector<HTMLSelectElement>('#krEsFish')!;
    fish.onchange = () => save({ fish: fish.value, lb: Math.round(SPECIES[fish.value].max * 0.8) });
    const lb = deed.querySelector<HTMLInputElement>('#krEsLb')!;
    lb.onchange = () => save({ lb: Number(lb.value) });
    const mount = deed.querySelector<HTMLSelectElement>('#krEsMount')!;
    mount.onchange = () => save({ mount: mount.value as Build['mount'] });
    const tr = deed.querySelector<HTMLInputElement>('#krEsTrophies')!;
    tr.oninput = () => { deed.querySelector('.krEsTrN')!.textContent = tr.value; };
    tr.onchange = () => save({ trophies: Number(tr.value) });
    const pool = deed.querySelector<HTMLInputElement>('#krEsPool')!;
    pool.onchange = () => save({ pool: pool.checked });
    const fire = deed.querySelector<HTMLInputElement>('#krEsFire')!;
    fire.onchange = () => save({ firepit: fire.checked });
  }

  /** The lot to scale, north up like the chart, with what stands on it — or would, with the
   * default build, before you buy. */
  function drawPlan(p: Parcel, build: Build | null, party: boolean): void {
    const S = deed.querySelector<SVGSVGElement>('.krEsPlan')!;
    const owned = registry.owner(p.id);
    const L = siteLayout(p, build ?? owned?.build ?? { res: 'villa', dock: 'sport', fish: 'marlin', lb: 512, mount: 'gallows', trophies: 3, pool: true, firepit: false });
    const ext = [...p.poly];
    if (L.dock) ext.push([L.dock.x1, L.dock.z1]);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ext) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const m = Math.max(x1 - x0, z1 - z0) * 0.12 + 8;
    S.setAttribute('viewBox', `${x0 - m} ${z0 - m} ${x1 - x0 + 2 * m} ${z1 - z0 + 2 * m}`);
    const k = (x1 - x0 + 2 * m) / 400;
    svgEl('rect', { x: x0 - m, y: z0 - m, width: x1 - x0 + 2 * m, height: z1 - z0 + 2 * m, class: p.tier === 'harbor' ? 'krEsPlanTown' : 'krEsPlanSea' }, S);
    svgEl('polygon', { points: pts(p.poly), class: 'krEsPlanLot', 'stroke-width': 1.5 * k }, S);
    const deg = (-L.heading * 180) / Math.PI;
    const rect = (x: number, z: number, w: number, d: number, cls: string) =>
      svgEl('rect', { x: x - w / 2, y: z - d / 2, width: w, height: d, class: cls, transform: `rotate(${deg} ${x} ${z})`, 'stroke-width': k }, S);
    if (party) svgEl('circle', { cx: L.house.x, cy: L.house.z, r: Math.max(L.house.w, L.house.d) * 1.6 + 10, class: 'krEsPlanGlow' }, S);
    if (L.dock) {
      const d = L.dock, mx = (d.x0 + d.x1) / 2, mz = (d.z0 + d.z1) / 2;
      rect(mx, mz, d.w, d.len, 'krEsPlanDock');
      if (d.tHead) rect(d.x1 - L.sea[0] * 2.5, d.z1 - L.sea[1] * 2.5, d.tHead, 5, 'krEsPlanDock');
    }
    if (L.pool) rect(L.pool.x, L.pool.z, 8, 4, 'krEsPlanPool');
    if (L.firepit) svgEl('circle', { cx: L.firepit.x, cy: L.firepit.z, r: 1.6, class: 'krEsPlanFire' }, S);
    for (const t of L.trophies) svgEl('circle', { cx: t.x, cy: t.z, r: 1.2, class: 'krEsPlanTrophy' }, S);
    rect(L.house.x, L.house.z, L.house.w, L.house.d, 'krEsPlanHouse');
    svgEl('circle', { cx: L.mount.x, cy: L.mount.z, r: 1.4, class: 'krEsPlanMount' }, S);
    const res = RESIDENCES[(build ?? owned?.build)?.res ?? 'villa'];
    const note = deed.querySelector<HTMLElement>('.krEsPlanNote')!;
    note.textContent = `${res.label}${L.dock ? ' · ' + DOCKS[(build ?? owned?.build)?.dock ?? 'sport'].label.toLowerCase() : ''}. Drawn to scale from the parcel, north up.`
      + (p.tier === 'harbor' ? ' On the town pad.' : ' Tie up at the dock to step ashore.');
  }

  /* ---------------------------------------------------------------- open/close */

  function paintCash(): void { cashEl.textContent = `Wallet ${money(wallet.cash())}`; }

  function open(): void {
    panel.classList.remove('hidden');
    paintCash(); renderLegend(); paintLots(); renderDeed();
    void registry.refresh();
  }
  function close(): void { panel.classList.add('hidden'); tip.classList.add('hidden'); }

  openBtn.onclick = open;
  $<HTMLButtonElement>('.krEsClose').onclick = close;
  panel.addEventListener('click', (ev) => { if (ev.target === panel) close(); });
  // The game binds most letters; while the office is open, keys belong to it.
  panel.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') close(); });
  panel.addEventListener('keyup', (ev) => ev.stopPropagation());

  const unsub = registry.subscribe(() => { if (!panel.classList.contains('hidden')) { paintLots(); renderDeed(); } });
  const unsubCash = wallet.subscribe?.(() => { if (!panel.classList.contains('hidden')) paintCash(); });

  renderDeed();
  return {
    open, close,
    /** Opens the office on one lot (a debug hook, and "read the deed" from the world). */
    show(id: string): void { open(); select(id); const p = parcelById(id); if (p) setView(bbox([p], 3)); },
    get isOpen(): boolean { return !panel.classList.contains('hidden'); },
    dispose(): void { unsub(); unsubCash?.(); openBtn.remove(); panel.remove(); },
  };
}

export type EstatesPanel = ReturnType<typeof mountEstatesPanel>;
