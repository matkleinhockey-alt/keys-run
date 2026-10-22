/**
 * The Pink Flamingo's two stage performers as real rigged models (entities/crew-model/, built by
 * packages/assets-pipeline/scripts/build-dance.sh `stripper` and `annie`) instead of the procedural
 * box-person everyone else in town is.
 *
 * A `StageDancer` is the same shape a `Person` needs from a figure -- a `group` the placement code
 * positions and turns, and a per-frame `update` -- so interiors.ts and town.ts treat it like any
 * other occupant of the room. Everything specific to a rigged figure lives here:
 *
 *  - It loads asynchronously. The room is built synchronously and never waits; the dancer pops into
 *    its group when the (cached, once per model) glTF resolves. If the load fails the procedural
 *    figure `fallback` makes is used instead, so the stage is never empty.
 *  - It is `SkeletonUtils.clone`d from the shared template, NOT `Object3D.clone()`: a plain clone
 *    leaves every copy sharing one skeleton and so one pose.
 *  - The clip runs on solid ground: no sea-legs (see crew-model/dance.ts `createStageFigure`).
 *  - Geometry and materials are the template's, shared by every clone, so `dispose` must NOT free
 *    them (a rebuilt room would find them gone); it only stops the mixer.
 */
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadDancerAsset, type DancerKind } from '../crew-model/asset.js';
import { createFallbackBeatSource } from '../crew-model/beat.js';
import { createStageFigure, updateStageFigure, type StageFigure } from '../crew-model/dance.js';
import type { Human } from '../life/human.js';

/** One steady tempo for the whole room; the real music controller plugs in here the same way it
 * does for the boat crew (see crew-model/beat.ts). */
const CLUB_BEAT = createFallbackBeatSource(118);

export interface StageDancer {
  /** Positioned/turned by the caller; the model (or the fallback figure) is its child. */
  group: THREE.Group;
  update(t: number, dt: number): void;
  /**
   * VERIFICATION ONLY (`__townDebug.dancers()`). The three things a screenshot cannot settle:
   * whether the rigged model loaded or the fallback did, where the figure's feet actually are
   * (a dancer at floor level is standing inside her own stage), and whether the clip is running
   * — `hand` is a world position the harness samples twice and diffs.
   */
  debug(): { id: string; rigged: boolean; bones: number; footY: number | null; topY: number | null; centre: [number, number] | null; hand: [number, number, number] | null };
  dispose(): void;
}

export function createStageDancer(rig: DancerKind, fallback: () => Human, seed: number): StageDancer {
  const group = new THREE.Group();
  group.name = `stage-dancer-${rig}`;
  let figure: StageFigure | null = null;
  let human: Human | null = null;
  let disposed = false;

  loadDancerAsset(rig)
    .then(({ template, clip }) => {
      if (disposed) return;
      const obj = cloneSkinned(template);
      group.add(obj);
      figure = createStageFigure(obj, clip, seed * 0.37);
    })
    .catch((err: unknown) => {
      if (disposed) return;
      console.error(`[town] stage dancer "${rig}" failed to load; using the procedural figure`, err);
      human = fallback();
      group.add(human.group);
    });

  const tmpBox = new THREE.Box3();
  const tmpVec = new THREE.Vector3();

  return {
    group,
    debug() {
      let bones = 0, skinned = 0;
      let hand: THREE.Bone | null = null;
      tmpBox.makeEmpty();
      group.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) { skinned++; o.updateMatrixWorld(true); tmpBox.expandByObject(o); }
        // Either skeleton naming, and neither puts "Hand" last: Mixamo's `mixamorig:LeftHand` does,
        // but annie's VRM export suffixes an index (`J_Bip_L_Hand_058`), so this matches anywhere in
        // the name. Her physics colliders are named after the bone they hang off (`..._collider_0_013`)
        // and are not driven by the clip, so they are excluded or this picks an unmoving node.
        if ((o as THREE.Bone).isBone) { bones++; if (!hand && /hand/i.test(o.name) && !/collider/i.test(o.name)) hand = o as THREE.Bone; }
      });
      if (hand) (hand as THREE.Bone).updateMatrixWorld(true);
      const h = hand ? tmpVec.setFromMatrixPosition((hand as THREE.Bone).matrixWorld) : null;
      return {
        id: group.name, rigged: skinned > 0, bones,
        footY: tmpBox.isEmpty() ? null : +tmpBox.min.y.toFixed(3),
        topY: tmpBox.isEmpty() ? null : +tmpBox.max.y.toFixed(3),
        // where the BODY actually is, not where the group was put: a model the pipeline left
        // off its own origin stands somewhere other than the mark the room placed it on.
        centre: tmpBox.isEmpty() ? null : [+((tmpBox.min.x + tmpBox.max.x) / 2).toFixed(3), +((tmpBox.min.z + tmpBox.max.z) / 2).toFixed(3)],
        hand: h ? [+h.x.toFixed(4), +h.y.toFixed(4), +h.z.toFixed(4)] : null,
      };
    },
    update(t, dt) {
      if (figure) updateStageFigure(figure, dt, CLUB_BEAT);
      else if (human) human.update(t, 0);
    },
    dispose() {
      disposed = true;
      if (figure) { figure.mixer.stopAllAction(); figure.mixer.uncacheRoot(figure.object); }
      if (human) human.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      group.clear();
    },
  };
}
