"""
Retargets the Mixamo "Hip Hop Dancing" clip (raw/hiphop_dancing.fbx) onto a model that ALREADY
HAS ITS OWN humanoid skeleton and skin weights — i.e. the second half of rig-dancer.blender.py
(the clip) without the first half (the auto-rig), because there is nothing to auto-rig.

Two models go through here (pick with the second argument):

  annie     raw/annie_anime_girl_2.glb: a VRM-style (`J_Bip_*`) T-pose avatar, skinned, with finger,
            hair and bust joints, and NO animation. Nothing to rig; only the clip is retargeted.
  stripper  raw/1312_stripper.glb: a 1,352-triangle UNRIGGED static mesh sculpted in a crouched,
            one-hand-in-hair stance (see build_stripper() below for why the Mixamo T-pose skeleton
            that rig-dancer.blender.py uses for the boat's dancer is the wrong tool for it).

    blender --background --python scripts/retarget-dancer.blender.py -- <out.glb> [annie|stripper]

--- Why this is not "rename the bones" ---
A Mixamo clip stores each bone's rotation as a quaternion in that bone's OWN local frame, and a
different skeleton's bones have different local frames (different roll, different rest axes), so
the same numbers mean a different movement. Both rigs here stand in a T-pose facing -Y (checked
numerically in this script: toes sit at smaller Y than the heels), so the movement can be carried
in WORLD space instead: for each mapped bone, per frame,

    target_world_rot = (source_world_rot @ source_rest_world_rot^-1) @ target_rest_world_rot

i.e. "however far the source bone has rotated away from its T-pose, rotate the target bone the
same way, away from ITS T-pose". Bones are posed parents-first from a cleared pose so each head
lands where the (already posed) parent puts it. Hip translation is scaled by the ratio of hip
heights (Annie's hips are at 0.91 m, Mixamo's at 1.04 m) so the feet do not skate or sink, and
its XZ travel is left in (it is only +-15 cm; the clip is an in-place dance).

--- What is deliberately NOT animated ---
  * Fingers/thumbs: Mixamo's finger rest axes differ too much from this model's for a world-space
    copy to be trusted, and the clip barely uses them. They hold the model's own relaxed rest.
  * The `J_Sec_*_Bust*` joints. They get no keys at all: nothing in the clip drives them and none
    is added. (The build script greps the finished glTF for them and fails if one is ever animated.)
  * Colliders/eye-adjust joints.
  Hair is the one secondary system added, and it is baked INTO the clip as keyframes, so the
  runtime needs no physics: each HairJoint chain follows the head's world rotation with a lag that
  grows down the chain (see HAIR_*), which reads as hair swinging behind the head's motion.
"""
import bpy, sys, os, math
from mathutils import Vector, Matrix, Quaternion

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(SCRIPT_DIR, "..", "raw")
argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
OUT_GLB = argv[0] if argv else os.path.join(SCRIPT_DIR, "..", "build", "dance-annie", "rigged.glb")
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
WHICH = argv[1] if len(argv) > 1 else "annie"
assert WHICH in ("annie", "stripper"), WHICH
MODEL = os.path.join(RAW, {"annie": "annie_anime_girl_2.glb", "stripper": "1312_stripper.glb"}[WHICH])

# Mixamo bone -> prefix of the target bone's name (the glTF importer appends a numeric suffix).
MAP = [
    ("Hips", "J_Bip_C_Hips"), ("Spine", "J_Bip_C_Spine"), ("Spine1", "J_Bip_C_Chest"),
    ("Spine2", "J_Bip_C_UpperChest"), ("Neck", "J_Bip_C_Neck"), ("Head", "J_Bip_C_Head"),
    ("LeftShoulder", "J_Bip_L_Shoulder"), ("LeftArm", "J_Bip_L_UpperArm"),
    ("LeftForeArm", "J_Bip_L_LowerArm"), ("LeftHand", "J_Bip_L_Hand"),
    ("RightShoulder", "J_Bip_R_Shoulder"), ("RightArm", "J_Bip_R_UpperArm"),
    ("RightForeArm", "J_Bip_R_LowerArm"), ("RightHand", "J_Bip_R_Hand"),
    ("LeftUpLeg", "J_Bip_L_UpperLeg"), ("LeftLeg", "J_Bip_L_LowerLeg"),
    ("LeftFoot", "J_Bip_L_Foot"), ("LeftToeBase", "J_Bip_L_ToeBase"),
    ("RightUpLeg", "J_Bip_R_UpperLeg"), ("RightLeg", "J_Bip_R_LowerLeg"),
    ("RightFoot", "J_Bip_R_Foot"), ("RightToeBase", "J_Bip_R_ToeBase"),
]
if WHICH == "stripper":
    MAP = [(m, m) for m, _ in MAP]   # the fitted skeleton reuses Mixamo's names
T = dict(MAP)                        # Mixamo bone -> target bone name (prefix)
# Hair swing: each joint down a chain lags the head's rotation by (index+1)*HAIR_LAG_FRAMES frames
# and takes HAIR_FOLLOW of the way from "head now" to "head then".
HAIR_LAG_FRAMES = 3
HAIR_FOLLOW = 0.75


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
bpy.ops.import_scene.fbx(filepath=os.path.join(RAW, "hiphop_dancing.fbx"))
src = bpy.data.objects['Armature']
for name in ('Beta_Joints', 'Beta_Surface'):
    o = bpy.data.objects.get(name)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)
action = src.animation_data.action
f0, f1 = int(action.frame_range[0]), int(action.frame_range[1])
print("source action", action.name, f0, f1)

before = set(bpy.data.objects)

# --- stripper: fit a Mixamo-named skeleton to a static mesh ------------------------------------
# Joint positions, in the mesh's own units after standing it up (x = her left, y = depth with her
# front toward -y, z = up; the mesh is 72.25 units tall), read off orthographic front/side renders
# of the model with a skeleton overlaid (run with PREVIEW=<dir> to write those overlay PNGs).
#
# Why a fitted skeleton and not rig-dancer.blender.py's approach (pose the T-pose Mixamo rig toward
# the mesh, apply as rest, auto-weight)? That works for the boat dancer because its mesh is a
# near-T/A-pose and only the arms had to move. This mesh is sculpted mid-crouch with a knee kicked
# out, and Mixamo's bone LENGTHS are fixed, so a re-posed Mixamo rig cannot put its knees and
# elbows where this mesh's are; heat-weighting against bones that miss the joints is what makes
# an auto-rig tear. A skeleton with the SAME bone names and hierarchy but THIS mesh's joint
# positions binds cleanly, and the clip is carried over exactly as for annie (world-space delta
# from each bone's rest, which is valid for any rest pose, crouched or not).
STRIPPER_SCALE = 1.62 / 72.25   # metres per mesh unit: a ~1.62 m woman, as she stands crouched
J = {  # joint name: head position
    "Hips": (-1.2, 2.5, 38.0), "Spine": (-1.2, 2.0, 42.5), "Spine1": (-1.2, 1.0, 48.0),
    "Spine2": (-1.0, -0.5, 53.5), "Neck": (-1.3, -1.5, 59.0), "Head": (-1.3, -2.0, 61.5),
    "HeadTop": (-0.8, -2.0, 72.0),
    "RightShoulder": (-2.0, -1.0, 57.2), "RightArm": (-5.7, -1.0, 56.8), "RightForeArm": (-15.2, -3.0, 65.9),
    "RightHand": (-10.5, -4.0, 67.0), "RightHandEnd": (-7.5, -4.5, 68.5),
    "LeftShoulder": (-0.5, -1.0, 57.2), "LeftArm": (7.4, -1.0, 56.5), "LeftForeArm": (9.0, 3.0, 46.0),
    "LeftHand": (6.0, -0.5, 32.0), "LeftHandEnd": (5.5, -1.0, 28.5),
    "RightUpLeg": (-4.5, 2.0, 36.5), "RightLeg": (-4.0, -8.0, 24.5), "RightFoot": (-4.6, -4.5, 4.0),
    "RightToeBase": (-4.6, -10.5, 0.8), "RightToeEnd": (-4.6, -13.0, 0.4),
    "LeftUpLeg": (1.9, 2.0, 36.5), "LeftLeg": (15.5, -11.5, 26.0), "LeftFoot": (10.9, -5.0, 4.6),
    "LeftToeBase": (10.9, -10.5, 1.0), "LeftToeEnd": (10.9, -13.0, 0.5),
}
# (bone, parent, tail joint)
STRIPPER_BONES = [
    ("Hips", None, "Spine"), ("Spine", "Hips", "Spine1"), ("Spine1", "Spine", "Spine2"),
    ("Spine2", "Spine1", "Neck"), ("Neck", "Spine2", "Head"), ("Head", "Neck", "HeadTop"),
    ("RightShoulder", "Spine2", "RightArm"), ("RightArm", "RightShoulder", "RightForeArm"),
    ("RightForeArm", "RightArm", "RightHand"), ("RightHand", "RightForeArm", "RightHandEnd"),
    ("LeftShoulder", "Spine2", "LeftArm"), ("LeftArm", "LeftShoulder", "LeftForeArm"),
    ("LeftForeArm", "LeftArm", "LeftHand"), ("LeftHand", "LeftForeArm", "LeftHandEnd"),
    ("RightUpLeg", "Hips", "RightLeg"), ("RightLeg", "RightUpLeg", "RightFoot"),
    ("RightFoot", "RightLeg", "RightToeBase"), ("RightToeBase", "RightFoot", "RightToeEnd"),
    ("LeftUpLeg", "Hips", "LeftLeg"), ("LeftLeg", "LeftUpLeg", "LeftFoot"),
    ("LeftFoot", "LeftLeg", "LeftToeBase"), ("LeftToeBase", "LeftFoot", "LeftToeEnd"),
]


def build_stripper():
    bpy.ops.import_scene.gltf(filepath=MODEL)
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o not in before)
    # The file is Z-up authored but exported without the Y-up conversion, so the importer leaves
    # her lying down (height along -Y). Bake world transform, stand her up (-90 X), shrink to metres.
    mesh.data.transform(mesh.matrix_world)
    bpy.context.view_layer.objects.active = mesh
    for o in bpy.data.objects:
        o.select_set(False)
    mesh.select_set(True)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    mesh.matrix_world = Matrix.Identity(4)
    mesh.data.transform(Matrix.Scale(STRIPPER_SCALE, 4) @ Matrix.Rotation(math.radians(-90), 4, 'X'))
    mesh.data.update()
    # UV seams split vertices; heat-weighting needs a connected surface (see rig-dancer.blender.py
    # docstring point 3), so weld by distance. UVs live on loops and survive.
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    nb = len(mesh.data.vertices)
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.object.mode_set(mode='OBJECT')
    print("stripper weld", nb, "->", len(mesh.data.vertices), "verts")

    # The source material is KHR_materials_unlit (baked-looking, ignores every light), which would
    # glow like a cut-out in a room whose whole look is its lighting; and an unlit export carries no
    # normals. Rebuild it as a plain lit Principled material on the SAME texture. Nothing about the
    # clothes or the texture changes.
    for mat in mesh.data.materials:
        nt = mat.node_tree
        tex_name = next(n.name for n in nt.nodes if n.type == 'TEX_IMAGE')
        for n in list(nt.nodes):
            if n.name != tex_name:
                nt.nodes.remove(n)
        tex = nt.nodes[tex_name]
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        bsdf.inputs['Roughness'].default_value = 0.85
        nt.links.new(tex.outputs[0], bsdf.inputs[0])
        nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        mat.use_backface_culling = False

    arm_data = bpy.data.armatures.new("StripperRig")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.data.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    sc = STRIPPER_SCALE
    for name, parent, tail in STRIPPER_BONES:
        eb = arm_data.edit_bones.new("mixamorig:" + name)
        eb.head = Vector(J[name]) * sc
        eb.tail = Vector(J[tail]) * sc
        if parent:
            eb.parent = arm_data.edit_bones["mixamorig:" + parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in arm_data.bones:
        if b.name.endswith(("HandEnd", "ToeEnd", "HeadTop")):
            b.use_deform = False
    for o in bpy.data.objects:
        o.select_set(False)
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    # Bind with EMPTY vertex groups, then weight by distance to the bone segments ("envelope" skinning)
    # instead of Blender's heat-map: this mesh is clothing built as separate overlapping shells (bikini
    # top, straps, gloves, boots, money) over a body shell, and heat diffusion solves each connected
    # shell on its own, so a strap and the skin under it got different weights and tore apart the moment
    # a joint moved (seen in the first render across the dance). Distance weights depend only on WHERE a
    # vertex is, so every shell that overlaps in space moves together.
    result = bpy.ops.object.parent_set(type='ARMATURE_NAME')
    print("stripper parent_set", result, "vertex groups", len(mesh.vertex_groups))
    segs = []
    for b in arm_data.bones:
        if b.use_deform:
            segs.append((b.name, Vector(b.head_local), Vector(b.tail_local)))
    EPS, POWER, KEEP = 0.02, 2.0, 4
    for v in mesh.data.vertices:
        ds = []
        for name, a, bb in segs:
            ab = bb - a
            t = max(0.0, min(1.0, (v.co - a).dot(ab) / max(ab.length_squared, 1e-12)))
            ds.append(((v.co - (a + ab * t)).length, name))
        ds.sort()
        near = ds[:KEEP]
        ws = [1.0 / (d + EPS) ** POWER for d, _ in near]
        tot = sum(ws)
        for (d, name), w in zip(near, ws):
            mesh.vertex_groups[name].add([v.index], w / tot, 'REPLACE')
    return arm, [mesh, arm]


if WHICH == "annie":
    bpy.ops.import_scene.gltf(filepath=MODEL)
    new_objs = [o for o in bpy.data.objects if o not in before]
    tgt = next(o for o in new_objs if o.type == 'ARMATURE')
else:
    tgt, new_objs = build_stripper()
print("target armature", tgt.name, len(tgt.data.bones), "bones")


def tbone(prefix):
    if WHICH == "stripper":
        return "mixamorig:" + prefix
    for b in tgt.data.bones:
        if b.name.startswith(prefix + "_") and not any(s in b.name for s in ("collider", "end")):
            return b.name
    raise RuntimeError("no target bone for " + prefix)


# The glTF importer does not give this skeleton an identity pose: the Sketchfab joints carry FBX-style
# pre-rotations (Root_022 is turned ~180 degrees, the Hips another ~172), so Blender's edit-bone "rest"
# is NOT the standing T-pose; the standing T-pose is the pose the importer leaves the bones in (that is
# the glTF's own node TRS, = its bind pose). So "rest" for the target is that initial POSE, recorded
# here before anything is touched, and every unmapped bone is reset to its recorded basis, not identity.
# Both rigs are then compared in true world space (matrix_world @ pose matrix).
bpy.context.view_layer.objects.active = tgt
bpy.context.view_layer.update()
init_basis = {pb.name: pb.matrix_basis.copy() for pb in tgt.pose.bones}
init_pose = {pb.name: (tgt.matrix_world @ pb.matrix).copy() for pb in tgt.pose.bones}


def rest_rot(arm, bone):  # rest orientation in true world space
    if arm is src:
        return (src.matrix_world @ bone.matrix_local).to_3x3().normalized().to_quaternion()
    return init_pose[bone.name].to_3x3().normalized().to_quaternion()


def head_world(arm, bone):
    if arm is src:
        return (src.matrix_world @ bone.matrix_local).translation.copy()
    return init_pose[bone.name].translation.copy()


# facing sanity check: both rigs must face the same way for a world-space copy to be valid
def facing(arm, foot, toe):
    return (head_world(arm, arm.data.bones[toe]) - head_world(arm, arm.data.bones[foot])).y
print("target hips world", head_world(tgt, tgt.data.bones[tbone(T["Hips"])]), "head", head_world(tgt, tgt.data.bones[tbone(T["Head"])]))
mx_f = facing(src, 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase')
tg_f = facing(tgt, tbone(T["LeftFoot"]), tbone(T["LeftToeBase"]))
print("facing (toe-foot y): mixamo", mx_f, "target", tg_f)
assert mx_f * tg_f > 0, "rigs face opposite ways; add a yaw to the delta"

pairs = [("mixamorig:" + s, tbone(t)) for s, t in MAP]
src_rest = {s: rest_rot(src, src.data.bones[s]) for s, _ in pairs}
tgt_rest = {t: rest_rot(tgt, tgt.data.bones[t]) for _, t in pairs}
hips_ratio = head_world(tgt, tgt.data.bones[tbone(T["Hips"])]).z / head_world(src, src.data.bones['mixamorig:Hips']).z
print("hip height ratio", hips_ratio)
src_hips_rest = head_world(src, src.data.bones['mixamorig:Hips'])

# hair chains: bones named HairJoint-*, grouped by chain (walk down from each one parented to the head)
head_name = tbone(T["Head"])
hair_chains = []
for b in tgt.data.bones:
    if b.name.startswith("HairJoint") and b.parent and b.parent.name == head_name:
        chain, cur = [], b
        while cur is not None and cur.name.startswith("HairJoint"):
            chain.append(cur.name)
            cur = cur.children[0] if cur.children else None
        hair_chains.append(chain)
print("hair chains", [len(c) for c in hair_chains])

# pass 1: head world delta per frame (needed for the hair lag)
frames = list(range(f0, f1 + 1))
bpy.context.view_layer.objects.active = src
head_delta = {}
for fr in frames:
    bpy.context.scene.frame_set(fr)
    r = (src.matrix_world @ src.pose.bones['mixamorig:Head'].matrix).to_3x3().normalized().to_quaternion()
    head_delta[fr] = r @ src_rest['mixamorig:Head'].inverted()
n = len(frames)

# pass 2: pose the target every frame and key it
tgt.animation_data_create()
tact = bpy.data.actions.new("mixamo.com")
tgt.animation_data.action = tact
for pb in tgt.pose.bones:
    pb.rotation_mode = 'QUATERNION'
posed = [t for _, t in pairs]
hair_all = [h for c in hair_chains for h in c]
bpy.context.view_layer.objects.active = tgt


inv_tgt = tgt.matrix_world.inverted()


def set_world_rot(pb, rot_q):
    m = Matrix.Translation((tgt.matrix_world @ pb.matrix).translation) @ rot_q.to_matrix().to_4x4()
    pb.matrix = inv_tgt @ m
    bpy.context.view_layer.update()


hips_t = tbone(T["Hips"])
for idx, fr in enumerate(frames):
    bpy.context.scene.frame_set(fr)
    for pb in tgt.pose.bones:
        pb.matrix_basis = init_basis[pb.name]
    bpy.context.view_layer.update()
    for s, t in pairs:
        spb = src.pose.bones[s]
        sw = (src.matrix_world @ spb.matrix).to_3x3().normalized().to_quaternion()
        delta = sw @ src_rest[s].inverted()
        pb = tgt.pose.bones[t]
        if s == "mixamorig:Hips":
            dh = (src.matrix_world @ spb.matrix).translation - src_hips_rest
            m = Matrix.Translation((tgt.matrix_world @ pb.matrix).translation + dh * hips_ratio) @ (delta @ tgt_rest[t]).to_matrix().to_4x4()
            pb.matrix = inv_tgt @ m
            bpy.context.view_layer.update()
        else:
            set_world_rot(pb, delta @ tgt_rest[t])
    if fr == f0 and os.environ.get("RETARGET_DEBUG"):
        for s_, t_ in pairs:
            got = (tgt.matrix_world @ tgt.pose.bones[t_].matrix).to_3x3().normalized().to_quaternion()
            sw_ = (src.matrix_world @ src.pose.bones[s_].matrix).to_3x3().normalized().to_quaternion()
            want = (sw_ @ src_rest[s_].inverted()) @ tgt_rest[t_]
            print("DBG", t_, "err_deg", round(math.degrees(got.rotation_difference(want).angle), 2), "delta_deg", round(math.degrees((sw_ @ src_rest[s_].inverted()).angle), 1))
    for chain in hair_chains:
        for j, name in enumerate(chain):
            lag = (j + 1) * HAIR_LAG_FRAMES
            now = head_delta[fr]
            then = head_delta[frames[(idx - lag) % n]]
            d = now.slerp(then, HAIR_FOLLOW)
            pb = tgt.pose.bones[name]
            set_world_rot(pb, d @ rest_rot(tgt, tgt.data.bones[name]))
    for t in posed + hair_all:
        pb = tgt.pose.bones[t]
        pb.keyframe_insert("rotation_quaternion", frame=fr)
        if t == hips_t:
            pb.keyframe_insert("location", frame=fr)
print("keyed", n, "frames,", len(posed), "body bones,", len(hair_all), "hair bones")

# drop the Mixamo rig and export only the model
bpy.data.objects.remove(src, do_unlink=True)
bpy.data.actions.remove(action)  # else the exporter also writes the (now targetless) Mixamo action
for o in bpy.data.objects:
    o.select_set(o in new_objs)
bpy.context.scene.frame_set(f0)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format='GLB', use_selection=True,
    export_animations=True, export_frame_range=False, export_force_sampling=True,
    export_skins=True, export_morph=False, export_yup=True, export_apply=False,
)
print("wrote", OUT_GLB)
print("DONE retarget-dancer")
