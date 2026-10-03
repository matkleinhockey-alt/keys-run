/**
 * Boot: build the world (declaration-only modules, explicit init order — see
 * docs/ARCHITECTURE.md requirement 4 and game/world.ts), then run the render loop.
 *
 * Ported from legacy/index.html:4178-4208 (resize, context-loss recovery, `frame()`), with one
 * deliberate change required by docs/ARCHITECTURE.md requirement 2: legacy ran physics at
 * render rate (`dt=Math.min(.05,clock.getDelta())` fed straight into `updateBoat`); the fixed
 * 30 Hz accumulator this requires now lives in `World.frame()` (game/world.ts), which this file
 * just calls once per animation frame with the real elapsed time.
 */
import { initWorld } from './game/world.js';
import { toast } from './ui/toast.js';

const wrap = document.getElementById('wrap');
if (!wrap) throw new Error('main: #wrap not found');

const world = initWorld(wrap);

new ResizeObserver(() => world.resize()).observe(wrap);
world.resize();

world.renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  try { toast('Graphics hiccup — refreshing the screen…'); } catch { /* noop */ }
  setTimeout(() => {
    if (world.renderer.getContext().isContextLost()) location.reload();
  }, 1500);
});
world.renderer.domElement.addEventListener('webglcontextrestored', () => {
  world.resize();
});

let last = performance.now();
let frameErrT = -99;
function frame(): void {
  requestAnimationFrame(frame); // keep the loop alive no matter what
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  try {
    world.frame(dt);
  } catch (e) {
    const t = now / 1000;
    if (t - frameErrT > 5) { frameErrT = t; console.error('frame update error', e); }
  }
}
frame();
