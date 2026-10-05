"""
Binds the realistic `bikini_girl.glb` mesh to the Mixamo `mixamorig:` skeleton + "Hip Hop
Dancing" clip carried by `hiphop_dancing.fbx` — i.e. does locally, via Blender's heat-map
"Automatic Weights", what Mixamo's own web auto-rigger would do: produce a rigged, animated
version of the REALISTIC model (not Mixamo's generic X Bot stand-in, which is what
`dance-01.glb` shipped until now — see docs/ASSET-LICENCES.md for the full history).

Run headless: `blender --background --python scripts/rig-dancer.blender.py -- <out.glb>`
(the `--` is Blender's own separator; everything after it is this script's argv).

--- Why each step below exists (debugging history, not just design) ---

1. Scale/orientation alignment. hiphop_dancing.fbx imports in centimetres, Y-up, with the
   Armature object carrying a 90 X rotation + 0.01 scale (Blender's standard FBX-to-Blender axis
   conversion). bikini_girl.glb imports normalised to exactly 1 unit tall. Both must land in the
   same real-world-metres, Z-up space before any bone math makes sense.

   IMPORTANT — do NOT `transform_apply()` the armature object to "clean up" that 90/0.01 import
   transform. Confirmed by direct measurement: applying it rewrites the edit-bone REST matrices,
   but does not retroactively rescale the action's own F-curve keyframes (authored in the old
   centimetre/Y-up local frame). The Hips bone carries this dance's root-motion translation, so
   those now-mismatched keyframes get reinterpreted in the new local frame and blow up by ~100x —
   observed as the mesh teleporting between world X=-15 and X=+16 frame to frame. Fix: leave the
   armature's native imported transform alone; all pose math below goes through
   `arm_obj.matrix_world` explicitly to work in real metres without ever touching that transform.

2. Pose alignment. bikini_girl's rest pose is not T-pose (Mixamo's rest) — she stands with both
   arms raised, hands at her head/hair. Binding straight to the unmodified T-pose skeleton would
   heat-weight her arms against bones nowhere near the actual arm geometry (the classic cause of a
   mangled auto-rig). Fix: bend the arm chain via pose-space rotations (`point_bone_toward`,
   computed from an estimate eyeballed off a render — see this task's report for that render) to
   roughly match her actual arm position, then `Apply Pose as Rest` so THAT becomes the bind pose.
   This is the standard Blender technique for an A/T-pose rest mismatch, and carries its usual
   caveat: replaying the ORIGINAL action (authored as deltas from true T-pose) against a now-bent
   rest is not a mathematically exact retarget (rotation composition isn't commutative), which
   shows up as visible-but-bounded arm elongation during the dance's biggest reach beats — see this
   task's report for the render-based judgment call on that trade-off. Legs/spine/neck are left at
   their original T-pose rest: both figures already stand straight with legs together, so no
   repose was needed there.

3. Merge by distance — REQUIRED, not cosmetic. bikini_girl.glb has 11,686 duplicate/overlapping
   vertices (a Sketchfab UV-seam/material-boundary export artifact), which inflates non-manifold
   edges to 20,756 and splits the mesh into 1,335 disconnected "islands". Blender's heat-weight
   solver cannot build its surface graph on that topology and fails for the ENTIRE mesh — not just
   a warning, confirmed as literally zero weighted vertices across every one of 65 vertex groups,
   including trivially-enclosed ones like Hips, reproduced even with a minimal 2-bone test rig
   standing in for the Mixamo skeleton. After this merge: 0 non-manifold edges, 1 island, and the
   solver works immediately.

4. Disabling deform on finger/end-effector bones. bikini_girl's hands/feet are smooth, fused
   sculpts with no separated fingers/toes — the 40 mixamorig finger bones' tips float outside any
   mesh surface for this model. Kept disabled as a defensive measure (a bone with no corresponding
   geometry is a known trigger for the same whole-mesh solver failure as point 3) even though the
   merge-by-distance fix above turned out to be the actual root cause of the earlier 100%-failure;
   it's correct practice either way, since there is no finger geometry for them to own.

--- Known limitation this script does NOT fix ---

Bone CHAIN LENGTHS are left at Mixamo's generic/X-Bot proportions (only rotated, never rescaled
per-bone) — bikini_girl's actual limb proportions aren't measured/matched. Combined with the
retarget-distortion caveat in point 2, this means the biggest-reach dance beats can show a
visibly-stretched (not torn, not exploded — just longer-looking than anatomically correct) arm.
See this task's report and the Blender-render screenshots for the honest before/after read on
this; a from-scratch IK-based limb-length retarget would remove it but was out of scope here.
"""
import bpy, sys, os
from mathutils import Vector, Matrix

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(SCRIPT_DIR, "..", "raw")

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
OUT_GLB = argv[0] if argv else os.path.join(SCRIPT_DIR, "..", "build", "dance", "rigged.glb")
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for block_set in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
        for block in list(block_set):
            try:
                block_set.remove(block)
            except Exception:
                pass


clear_scene()

# ---- 1. Import the Mixamo FBX, strip its own body + joint-preview meshes, keep rig + action ----
bpy.ops.import_scene.fbx(filepath=os.path.join(RAW, "hiphop_dancing.fbx"))
arm_obj = bpy.data.objects['Armature']
for name in ('Beta_Joints', 'Beta_Surface'):
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)

bpy.context.view_layer.objects.active = arm_obj
for o in bpy.data.objects:
    o.select_set(False)
arm_obj.select_set(True)

saved_action = arm_obj.animation_data.action if arm_obj.animation_data else None
print("saved action:", saved_action, saved_action.frame_range if saved_action else None)
if arm_obj.animation_data:
    arm_obj.animation_data.action = None
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.select_all(action='SELECT')
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode='OBJECT')

H = (arm_obj.matrix_world @ arm_obj.data.bones['mixamorig:Head'].tail_local).z
print("measured rig height H =", H)

# ---- 2. Import bikini_girl, recentre + rescale to H, feet at z=0 ----
bpy.ops.import_scene.gltf(filepath=os.path.join(RAW, "bikini_girl.glb"))
girl_mesh = None
for o in bpy.data.objects:
    if o.type == 'MESH' and o.name not in ('Beta_Joints', 'Beta_Surface'):
        girl_mesh = o
print("girl mesh:", girl_mesh.name, "verts:", len(girl_mesh.data.vertices))

mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
for corner in girl_mesh.bound_box:
    w = girl_mesh.matrix_world @ Vector(corner)
    mn.x = min(mn.x, w.x); mn.y = min(mn.y, w.y); mn.z = min(mn.z, w.z)
    mx.x = max(mx.x, w.x); mx.y = max(mx.y, w.y); mx.z = max(mx.z, w.z)
cx = (mn.x + mx.x) / 2.0
height_orig = mx.z - mn.z

girl_mesh.data.transform(girl_mesh.matrix_world)
bpy.context.view_layer.objects.active = girl_mesh
for o in bpy.data.objects:
    o.select_set(False)
girl_mesh.select_set(True)
bpy.ops.object.parent_clear(type='CLEAR')
bpy.context.view_layer.update()

k = H / height_orig
xform = Matrix.Scale(k, 4) @ Matrix.Translation((-cx, 0, -mn.z))
girl_mesh.data.transform(xform)
girl_mesh.data.update()
bpy.context.view_layer.update()

mn2 = Vector((1e9, 1e9, 1e9)); mx2 = Vector((-1e9, -1e9, -1e9))
for corner in girl_mesh.bound_box:
    w = girl_mesh.matrix_world @ Vector(corner)
    mn2.x = min(mn2.x, w.x); mn2.y = min(mn2.y, w.y); mn2.z = min(mn2.z, w.z)
    mx2.x = max(mx2.x, w.x); mx2.y = max(mx2.y, w.y); mx2.z = max(mx2.z, w.z)
print("girl bbox after:", mn2, mx2)

# ---- 2b. Merge by distance (see module docstring point 3 — required, not cosmetic) ----
bpy.context.view_layer.objects.active = girl_mesh
for o in bpy.data.objects:
    o.select_set(False)
girl_mesh.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
before_v = len(girl_mesh.data.vertices)
bpy.ops.mesh.remove_doubles(threshold=0.0001)
bpy.ops.object.mode_set(mode='OBJECT')
print(f"merge by distance: {before_v} -> {len(girl_mesh.data.vertices)} verts")

# ---- 3. Bend the arm chain to roughly match the girl's actual "hands near head" rest pose ----
bpy.context.view_layer.objects.active = arm_obj
for o in bpy.data.objects:
    o.select_set(False)
arm_obj.select_set(True)
bpy.ops.object.mode_set(mode='POSE')


def point_bone_toward(pbone, target_world):
    # pbone.matrix is in ARMATURE-local space; the armature object still carries its native
    # imported transform (rot 90 X, scale 0.01 — see module docstring point 1), so convert
    # explicitly through arm_obj.matrix_world rather than ever applying that transform.
    obj_mat = arm_obj.matrix_world
    mat_world = obj_mat @ pbone.matrix
    head_world = mat_world.translation.copy()
    current_dir = (mat_world.to_3x3() @ Vector((0, 1, 0))).normalized()
    desired_dir = (Vector(target_world) - head_world)
    if desired_dir.length < 1e-6:
        return
    desired_dir.normalize()
    delta = current_dir.rotation_difference(desired_dir)
    new_rot3_world = delta.to_matrix() @ mat_world.to_3x3()
    new_mat_world = Matrix.Translation(head_world) @ new_rot3_world.to_4x4()
    pbone.matrix = obj_mat.inverted() @ new_mat_world
    bpy.context.view_layer.update()


pb = arm_obj.pose.bones
point_bone_toward(pb['mixamorig:LeftArm'],      (0.24, -0.01, 1.52))
point_bone_toward(pb['mixamorig:LeftForeArm'],  (0.12,  0.02, 1.80))
point_bone_toward(pb['mixamorig:RightArm'],     (-0.24, -0.01, 1.52))
point_bone_toward(pb['mixamorig:RightForeArm'], (-0.12,  0.02, 1.80))

bpy.ops.pose.select_all(action='SELECT')
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')

# ---- 3b. Disable deform on bones with no corresponding mesh detail (see docstring point 4) ----
NO_DEFORM_SUBSTRINGS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')
NO_DEFORM_EXACT = ('mixamorig:HeadTop_End', 'mixamorig:LeftToe_End', 'mixamorig:RightToe_End')
disabled = []
for bone in arm_obj.data.bones:
    if any(s in bone.name for s in NO_DEFORM_SUBSTRINGS) or bone.name in NO_DEFORM_EXACT:
        bone.use_deform = False
        disabled.append(bone.name)
print(f"disabled deform on {len(disabled)} bones (fingers + end-effectors)")

# ---- 4. Parent mesh to armature with Automatic Weights (heat-map skinning) ----
for o in bpy.data.objects:
    o.select_set(False)
girl_mesh.select_set(True)
arm_obj.select_set(True)
bpy.context.view_layer.objects.active = arm_obj
result = bpy.ops.object.parent_set(type='ARMATURE_AUTO')
print("parent_set result:", result)
print("girl_mesh parent:", girl_mesh.parent, "vertex groups:", len(girl_mesh.vertex_groups))

# ---- 5. Reattach the original Hip Hop Dancing action, bake, export ----
if not arm_obj.animation_data:
    arm_obj.animation_data_create()
arm_obj.animation_data.action = saved_action
print("re-attached action:", arm_obj.animation_data.action)

for o in bpy.data.objects:
    o.select_set(False)
girl_mesh.select_set(True)
arm_obj.select_set(True)

bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format='GLB',
    use_selection=True,
    export_animations=True,
    export_frame_range=False,
    export_force_sampling=True,
    export_skins=True,
    export_morph=False,
    export_yup=True,
    export_apply=False,
)
print(f"wrote {OUT_GLB}")
print("DONE rig-dancer")
