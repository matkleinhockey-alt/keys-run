/** Barrel for the diver feature's public surface — see each module for details. */
export { createDiverController, NEUTRAL_BOAT_INPUT, type DiverController, type DiverMode, type DiverControllerDeps } from './controller.js';
export { createDiverButtons, bindDiverInput, type DiverButtons } from './input.js';
export { createDiverModel, type DiverModel } from './model.js';
export { applyDiverVisuals, type DiverVisualsCtx } from './visuals.js';
export { updateDiverCamera, DIVE_CAMERA_NEAR, DIVE_CAMERA_FAR, type DiverCamState, type DiverCamMode } from './camera.js';
export { updateDiverHud, showDiverHud, clearBlackoutOverlay, type DiverHudCtx } from './hud.js';
export { defaultSeafloorSampler, makeDiverEnv, DIVER_DT } from './physics.js';
