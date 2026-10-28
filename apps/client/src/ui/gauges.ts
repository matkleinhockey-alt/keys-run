/**
 * The dash: a tachometer, a speedometer and a trim gauge, built as real round instruments.
 *
 * The HUD used to be a number in big type with two label/value rows and a slider under it —
 * a readout, not a dashboard. A boat's helm is a cluster of round gauges, and the information
 * reads completely differently that way: a needle at two o'clock tells you where you are in the
 * band before you have read anything, which is the whole reason the instrument is round.
 *
 * ## SVG, built once
 *
 * The faces — bezel, ticks, numerals, the red band — never change, so they are built once as SVG
 * and only the needles move, through a CSS `transform` on one `<g>` each. Nothing is redrawn and
 * nothing allocates per frame, which is what a canvas gauge would cost at 10 Hz for no gain in
 * fidelity; the scales come out crisp at any DPR for free.
 *
 * The one thing that does get rebuilt is the speedometer's dial, because the boats run from a
 * 52-knot Robalo to an 82-knot Nor-Tech and a dial that reads to 82 for all of them wastes most
 * of its sweep. `setTopSpeed` re-ticks it when you switch boats.
 */

/** Needle travel, degrees either side of straight up. 264 degrees of sweep, like a real tach. */
const SWEEP = 132;
/** The trim gauge is a short-sweep instrument; a 264-degree trim dial would be nonsense. */
const TRIM_SWEEP = 62;

const NS = 'http://www.w3.org/2000/svg';
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** Point on the dial at `frac` (0..1) of the sweep, `r` from the centre of a 100x100 face. */
function pt(frac: number, r: number, sweep = SWEEP): [number, number] {
  const a = (-sweep + frac * sweep * 2) * Math.PI / 180;
  return [50 + Math.sin(a) * r, 50 - Math.cos(a) * r];
}

export interface Gauge {
  root: SVGSVGElement;
  /** Move the needle. `frac` is 0..1 of the dial; values outside are pinned. */
  set(frac: number): void;
  /** The group the caller can hang extra readouts on. */
  face: SVGGElement;
}

interface GaugeOpts {
  /** Where the numerals are drawn, in dial units. */
  majors: number[];
  /** How many minor ticks between majors. */
  minorsPer?: number;
  /** Top of the dial in the same units as `majors`. */
  span: number;
  /** Fraction of the dial from which the band is red. Omit for no band. */
  redFrom?: number;
  label?: string;
  sweep?: number;
  /** Numeral size; the trim gauge's letters want to be bigger than a tach's digits. */
  numSize?: number;
}

function buildFace(g: SVGGElement, o: GaugeOpts): void {
  const sweep = o.sweep ?? SWEEP;
  while (g.firstChild) g.removeChild(g.firstChild);
  if (o.redFrom !== undefined) {
    const [x0, y0] = pt(o.redFrom, 41, sweep), [x1, y1] = pt(1, 41, sweep);
    g.appendChild(el('path', {
      d: `M${x0} ${y0} A41 41 0 0 1 ${x1} ${y1}`, fill: 'none',
      stroke: 'var(--marker)', 'stroke-width': 3.4, 'stroke-linecap': 'round', opacity: 0.85,
    }));
  }
  const minors = o.minorsPer ?? 0;
  for (let i = 0; i < o.majors.length; i++) {
    const f = o.majors[i] / o.span;
    const [ax, ay] = pt(f, 44, sweep), [bx, by] = pt(f, 35, sweep);
    g.appendChild(el('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: 'var(--ink)', 'stroke-width': 2.1, 'stroke-linecap': 'round' }));
    const [tx, ty] = pt(f, 26, sweep);
    const t = el('text', {
      x: tx, y: ty + (o.numSize ?? 11) * 0.35, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-size': o.numSize ?? 11, 'font-weight': 700,
    });
    t.textContent = String(o.majors[i]);
    g.appendChild(t);
    if (i < o.majors.length - 1) {
      for (let m = 1; m <= minors; m++) {
        const mf = (o.majors[i] + (o.majors[i + 1] - o.majors[i]) * (m / (minors + 1))) / o.span;
        const [cx, cy] = pt(mf, 44, sweep), [dx, dy] = pt(mf, 39, sweep);
        g.appendChild(el('line', { x1: cx, y1: cy, x2: dx, y2: dy, stroke: 'var(--muted)', 'stroke-width': 1.2, opacity: 0.7 }));
      }
    }
  }
  if (o.label) {
    // Below the numerals, not above the pivot: the dial's lowest numerals sit at y~67, and a
    // label at 74 runs straight through them — the tach read "0RPM x1000".
    const t = el('text', { x: 50, y: 81, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 8.5, 'font-weight': 700, 'letter-spacing': 0.5 });
    t.textContent = o.label;
    g.appendChild(t);
  }
}

function makeGauge(o: GaugeOpts): Gauge & { rebuild(n: GaugeOpts): void } {
  const sweep = o.sweep ?? SWEEP;
  const root = el('svg', { viewBox: '0 0 100 100', class: 'gauge' });
  // Bezel and face. Two rings rather than one so it reads as a housing with glass in it.
  root.appendChild(el('circle', { cx: 50, cy: 50, r: 48, fill: 'rgba(4,18,32,.82)', stroke: 'var(--panel-edge)', 'stroke-width': 1.6 }));
  root.appendChild(el('circle', { cx: 50, cy: 50, r: 44.5, fill: 'none', stroke: 'rgba(255,255,255,.07)', 'stroke-width': 1 }));
  const face = el('g', {});
  root.appendChild(face);
  buildFace(face, o);

  // Needle: a long tapered blade with a short counterweight, on its own pivot group.
  const pivot = el('g', { class: 'needle' });
  pivot.appendChild(el('path', { d: 'M50 12 L52.6 50 L50 56 L47.4 50 Z', fill: 'var(--sun)' }));
  pivot.appendChild(el('circle', { cx: 50, cy: 50, r: 5.2, fill: 'rgba(12,30,48,.95)', stroke: 'var(--panel-edge)', 'stroke-width': 1.2 }));
  root.appendChild(pivot);

  let cur = o;
  return {
    root, face,
    set(frac: number) {
      const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      pivot.style.transform = `rotate(${-(cur.sweep ?? SWEEP) + f * (cur.sweep ?? SWEEP) * 2}deg)`;
    },
    rebuild(n: GaugeOpts) { cur = n; buildFace(face, n); void sweep; },
  };
}

export interface Dash {
  /** `rpm` in revs, `redline` where the band starts. */
  setTach(rpm: number, max: number): void;
  setSpeed(kn: number): void;
  /** `v` is 0..1, the same trim value the boat carries. */
  setTrim(v: number): void;
  /** Re-tick the speedo for a different boat. */
  setTopSpeed(kn: number): void;
}

/**
 * Build the cluster into `host`. Returns the three setters; everything else about the panel —
 * the name plate, the gear pill, the sounder and compass readouts — stays ordinary HTML.
 */
export function createDash(host: HTMLElement, topKn: number, redlineRpm: number, maxRpm: number): Dash {
  const tach = makeGauge({
    majors: [0, 1, 2, 3, 4, 5, 6], minorsPer: 1, span: maxRpm / 1000,
    redFrom: redlineRpm / maxRpm, label: 'RPM \u00D71000',
  });
  const speedo = makeGauge({ majors: speedMajors(topKn), minorsPer: 1, span: speedSpan(topKn), label: 'KNOTS' });
  const trim = makeGauge({ majors: [0, 50, 100], span: 100, sweep: TRIM_SWEEP, label: 'TRIM', numSize: 8 });

  tach.root.classList.add('g-big');
  speedo.root.classList.add('g-big');
  trim.root.classList.add('g-small');
  host.append(tach.root, speedo.root, trim.root);

  let span = speedSpan(topKn);
  return {
    setTach: (rpm, max) => tach.set(rpm / max),
    setSpeed: (kn) => speedo.set(kn / span),
    setTrim: (v) => trim.set(v),
    setTopSpeed(kn) {
      span = speedSpan(kn);
      speedo.rebuild({ majors: speedMajors(kn), minorsPer: 1, span, label: 'KNOTS' });
    },
  };
}

/** Round the dial up to a sensible top — a speedo reading to 61 is a speedo nobody made. */
export function speedSpan(topKn: number): number {
  return Math.max(20, Math.ceil((topKn * 1.08) / 10) * 10);
}

/** Numerals every 10 knots, or every 20 once the dial gets long enough to crowd. */
export function speedMajors(topKn: number): number[] {
  const span = speedSpan(topKn), step = span > 60 ? 20 : 10;
  const out: number[] = [];
  for (let v = 0; v <= span; v += step) out.push(v);
  return out;
}
