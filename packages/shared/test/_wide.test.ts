import { it } from 'vitest';
import { MARINAS, depthAt, landH } from '../src/world/depth.js';
import { BOATS } from '../src/content/boats.js';

const DEEPEST = Math.max(...BOATS.map((b) => b.draft));
it('wide', () => {
  const M = MARINAS[0];
  console.log(`${M.name} — '.'=deep enough (> ${(DEEPEST + 0.3).toFixed(2)}m)  '!'=too shallow  '#'=land`);
  const xs: number[] = []; for (let dx = -400; dx <= 400; dx += 20) xs.push(dx);
  console.log('        ' + xs.map((d) => (d % 100 === 0 ? '|' : ' ')).join(''));
  for (let r = 320; r >= -20; r -= 10) {
    const row = xs.map((dx) => {
      const x = M.sx + dx, z = M.sz + M.dir * r;
      if (landH(x, z) > 0.02) return '#';
      return depthAt(x, z) > DEEPEST + 0.3 ? '.' : '!';
    }).join('');
    console.log(String(r).padStart(5) + 'm  ' + row);
  }
});
