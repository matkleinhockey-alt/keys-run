/**
 * Fish swim in different ways, and now the renderer knows it.
 *
 * Every lateral swimmer used to share one wave: bending started 28% back, the envelope was the
 * same square law, the wavelength was the same 2.6 radians, and the tail beat at 7.5 rad/s —
 * 1.19 Hz — whatever the animal was. A 0.3 m lookdown and a 3.6 m blue marlin therefore beat
 * their tails at identical rates, and a tuna, whose body is a rigid strut built to hold still
 * while the tail works, undulated exactly like a bonefish.
 *
 * These pin the differences that are actually visible, not the numbers that produce them.
 */
import { describe, expect, it } from 'vitest';
import { VIS } from '@keysrun/shared/content/creatures';
import { lateralSwimAmp, swimAngSpeed, swimModeFor, swimWavenumber } from '../src/entities/fish/swim.js';

const hz = (k: string): number => swimAngSpeed(k, VIS[k]) / (Math.PI * 2);
/** How far the body is bent at 60% back, as a fraction of length — i.e. how stiff it looks. */
const bend60 = (k: string): number => lateralSwimAmp(k, VIS[k], 0.6) / VIS[k].len;

describe('swimming mode', () => {
  it('holds a thunniform body rigid and works only the tail', () => {
    for (const k of ['yellowfin', 'bluefin', 'wahoo', 'marlin', 'sailfish', 'mako', 'blackfin']) {
      expect(swimModeFor(k, VIS[k]), k).toBe('thunniform');
      // Nothing is moving at 60% of the way back on a tuna.
      expect(bend60(k), `${k} should be stiff forward`).toBe(0);
    }
  });

  it('bends an eel-shaped animal along its whole length', () => {
    for (const k of ['nurse', 'sawfish']) {
      expect(swimModeFor(k, VIS[k]), k).toBe('anguilliform');
      expect(bend60(k), `${k} should be bending well forward`).toBeGreaterThan(0.04);
    }
  });

  it('orders stiffness the way the modes do', () => {
    // A tuna is stiffer than a jack, which is stiffer than a barracuda, which is stiffer than
    // a nurse shark. This is the whole claim in one line.
    expect(bend60('yellowfin')).toBeLessThan(bend60('yellowtail'));
    expect(bend60('yellowtail')).toBeLessThan(bend60('barracuda'));
    expect(bend60('barracuda')).toBeLessThan(bend60('nurse'));
  });

  it('puts less than half a wave on a stiff fish and more than one on a limber one', () => {
    expect(swimWavenumber('yellowfin', VIS.yellowfin)).toBeLessThan(Math.PI);      // < half a wave
    expect(swimWavenumber('nurse', VIS.nurse)).toBeGreaterThan(Math.PI * 2);       // > a full wave
  });
});

describe('tail-beat rate', () => {
  it('beats faster the smaller the fish', () => {
    const order = ['lookdown', 'yellowtail', 'bonefish', 'barracuda', 'marlin', 'whaleshark'];
    for (let i = 1; i < order.length; i++) {
      expect(hz(order[i]), `${order[i]} vs ${order[i - 1]}`).toBeLessThan(hz(order[i - 1]));
    }
  });

  it('spans a real range instead of one rate for the whole ocean', () => {
    const all = Object.keys(VIS).map(hz);
    expect(Math.max(...all) / Math.min(...all), 'biggest/smallest beat').toBeGreaterThan(8);
    // ...and stays inside what an animal can actually do.
    for (const k of Object.keys(VIS)) {
      expect(hz(k), k).toBeGreaterThan(0.15);
      expect(hz(k), k).toBeLessThan(10);
    }
  });

  it('gives a thunniform swimmer a faster beat than its size alone would suggest', () => {
    // Small amplitude traded for high frequency is the defining bargain of the mode: the wahoo
    // is longer than the tarpon and still beats faster.
    expect(VIS.wahoo.len).toBeGreaterThan(VIS.tarpon.len * 0.8);
    expect(hz('wahoo')).toBeGreaterThan(hz('tarpon'));
  });
});
