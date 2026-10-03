/**
 * The one shared "what phase of the swim cycle is it" clock, mirroring legacy's module-level
 * `swimU = {uSwimT:{value:0}}` (index.html:2439) that every species' material's `onBeforeCompile`
 * pointed its own `uSwimT` uniform at. Every species material below shares this exact object, so
 * `index.ts`'s per-frame update sets it once instead of walking all ~49 materials.
 */
export const swimClock = { value: 0 };
