/**
 * "Run to": pick a fishing spot or a dock and go there.
 *
 * The spawn moved offshore to the rig field, which is 4.1 km from Boot Key Harbor — a long run at
 * displacement speed before you have done anything, and a longer one back with a cooler full.
 * This is the shortcut: the named places this world actually has, with how far each one is, and
 * the boat put down in clear water next to it.
 *
 * The list is DERIVED from the world data rather than typed out, so it cannot drift from where
 * things really are: the marinas come from `MARINAS` (their `ex`/`ez` approach point, which is
 * open water outside the basin rather than a berth), the offshore spots from `HUMPS`, and the
 * rigs from `RIG_SITES` — offset to one side so you arrive beside a platform and not inside its
 * legs.
 *
 * It refuses while something is going on that teleporting would spoil — a fish on the line, a
 * race, a tournament — via the same `refuse()` idea the handgun uses (game/world.ts).
 */
import { MARINAS, HUMPS } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';
import { RIG_SITES } from '../entities/life/hotspots.js';
import './runto.css';

export interface RunToPort {
  /** null when running is allowed; otherwise the reason to show instead. */
  refuse(): string | null;
  /** Put the boat in clear water at (x, z). */
  go(x: number, z: number, name: string): void;
  boat(): { x: number; z: number };
}

export interface Dest { name: string; note: string; x: number; z: number; }

/** Arrive this far off a rig, so you pull up beside it rather than inside the jacket. */
const RIG_STANDOFF = 130;

export function destinations(): Array<{ group: string; items: Dest[] }> {
  const rigAt = (kind: string, note: string): Dest[] => {
    const site = RIG_SITES.find(([, , k]) => k === kind);
    if (!site) return [];
    const [x, dz] = site;
    return [{ name: note, note: 'oil rig', x: x + RIG_STANDOFF, z: chainZ(x) + dz }];
  };
  return [
    {
      group: 'Back to the dock',
      items: MARINAS.map((m) => ({ name: m.name, note: 'marina', x: m.ex, z: m.ez })),
    },
    {
      group: 'Fishing spots',
      items: [
        { name: 'Sombrero Reef', note: 'the crest', x: 60, z: 1462 },
        ...HUMPS.map((h) => ({ name: h.name, note: h.patch ? 'patch reef' : 'offshore hump', x: h.x, z: chainZ(h.x) + h.dz })),
        ...rigAt('platform', 'The production platform'),
        ...rigAt('semisub', 'The deep rigs'),
      ],
    },
  ];
}

export interface RunTo { toggle(): void; close(): void; dispose(): void; }

export function createRunTo(host: HTMLElement, port: RunToPort): RunTo {
  let panel: HTMLDivElement | null = null;

  const close = (): void => { panel?.remove(); panel = null; };

  const open = (): void => {
    close();
    const here = port.boat();
    const why = port.refuse();
    panel = document.createElement('div');
    panel.className = 'krRunTo';
    const head = document.createElement('h3');
    head.textContent = 'Run to';
    const sub = document.createElement('p');
    sub.className = 'krRunSub';
    sub.textContent = why ? '' : 'Pick a spot and the boat will be there.';
    panel.append(head, sub);

    if (why) {
      const w = document.createElement('p');
      w.className = 'krRunWhy';
      w.textContent = why;
      panel.append(w);
    } else {
      for (const { group, items } of destinations()) {
        const g = document.createElement('div');
        g.className = 'krRunGroup';
        g.textContent = group;
        panel.append(g);
        for (const d of items) {
          const km = Math.hypot(d.x - here.x, d.z - here.z) / 1000;
          const b = document.createElement('button');
          b.className = 'krRunDest';
          b.type = 'button';
          const nm = document.createElement('b');
          nm.textContent = d.name;
          const far = document.createElement('i');
          far.textContent = `${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`} · ${d.note}`;
          b.append(nm, far);
          b.addEventListener('click', () => {
            const stop = port.refuse();
            if (stop) { close(); return; }
            port.go(d.x, d.z, d.name);
            close();
          });
          panel.append(b);
        }
      }
    }
    const x = document.createElement('button');
    x.className = 'krRunClose';
    x.type = 'button';
    x.textContent = 'Close';
    x.addEventListener('click', close);
    panel.append(x);
    host.appendChild(panel);
  };

  return {
    toggle(): void { if (panel) close(); else open(); },
    close,
    dispose(): void { close(); },
  };
}
