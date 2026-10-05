#!/usr/bin/env bash
# Builds the rigged, dancing deck-crew glTF — the REALISTIC `bikini_girl` mesh bound to the
# Mixamo `mixamorig:` skeleton + "Hip Hop Dancing" clip, two LODs, meshopt-compressed.
#
# --- What this ships now, vs before ---
# Earlier versions of this script shipped Mixamo's own generic "X Bot" mannequin (the mesh baked
# into `raw/hiphop_dancing.fbx` itself) dancing — a stand-in, not the project's actual crew figure
# (see docs/ASSET-LICENCES.md's "dance-01" entry for that whole history). This version does what
# that entry's own TODO asked for: runs `raw/bikini_girl.glb` (textured, 49,860 tris, NO skeleton)
# through a local auto-rigger — Blender's heat-map "Automatic Weights", the same class of
# technique Mixamo's own web auto-rigger uses — binding it to the Mixamo skeleton + animation
# instead. scripts/rig-dancer.blender.py does the actual rigging (see its own header for the full
# alignment/pose/topology debugging history: scale+orientation matching, bending the T-pose rig's
# arms to roughly match the girl's actual "hands at her hair" rest pose, and — the one genuinely
# load-bearing fix — merging 11,686 duplicate/overlapping vertices that otherwise left the mesh at
# 1,335 disconnected islands and made Blender's heat-weight solver fail on the ENTIRE mesh, not
# just a warning). The bind was judged by rendering it in Blender across the whole dance (not
# guessed at) — see this task's report and test/screenshots/crew-rigged/ for that render and the
# honest call on quality, including its one known limitation (Mixamo's generic bone-chain lengths
# aren't rescaled to the girl's actual limb proportions, which shows as visible-but-bounded arm
# elongation on the dance's biggest reach beats — not torn/exploded geometry).
#
# --- Pipeline ---
# 1. Blender (headless) imports both raw assets, aligns scale/pose, merges doubles, binds with
#    Automatic Weights, re-attaches the original action, exports one full-res (49,860-tri) rigged
#    GLB — scripts/rig-dancer.blender.py, see its header for the "why" of every step.
# 2. `gltf-transform optimize`, twice (near/far LOD), same tool build-crew.sh uses for the static
#    figure. Unlike this script's own earlier version, simplify is now ENABLED for this skinned
#    mesh: confirmed safe by direct render comparison (pre- vs post-simplify dance frames are
#    visually identical in pose/deformation, just lower-poly — see this task's report), so the
#    earlier blanket caution ("not confirmed safe on a skinned character") no longer applies to
#    this asset. flatten/join/instance/palette stay disabled regardless — those collapse the scene
#    graph in ways not needed here and not worth re-litigating for a single-figure, single-material
#    asset.
#
# Usage: ./scripts/build-dance.sh
# Writes:
#   apps/client/public/models/crew/dance-01.glb       (near LOD,  ~11-12k tris — what the game loads)
#   apps/client/public/models/crew/dance-01.lod1.glb   (far LOD,   ~5k tris — built, not yet wired to
#                                                        runtime LOD switching; same status as the
#                                                        static figure's unused crew-01.lod{0,1}.glb)
set -euo pipefail
cd "$(dirname "$0")/.."

BLENDER="${BLENDER:-blender}"
if ! command -v "$BLENDER" >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/blender /Applications/Blender.app/Contents/MacOS/Blender; do
    if [ -x "$candidate" ]; then BLENDER="$candidate"; break; fi
  done
fi

OUT_DIR="build/dance"
RIGGED="$OUT_DIR/rigged.glb"
FINAL_DIR="../../apps/client/public/models/crew"
GLTF="pnpm dlx @gltf-transform/cli"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "=== Blender: rig bikini_girl.glb to the Mixamo skeleton + Hip Hop Dancing clip ==="
"$BLENDER" --background --python scripts/rig-dancer.blender.py -- "$(pwd)/$RIGGED"

echo ""
echo "=== optimize: near LOD (~11-12k tris) -> dance-01.glb ==="
$GLTF optimize "$RIGGED" "$FINAL_DIR/dance-01.glb" \
  --simplify-ratio 0.24 --simplify-error 0.02 --texture-compress webp --texture-size 1024 --compress meshopt \
  --flatten false --join false --instance false --palette false --resample true --prune true

echo ""
echo "=== optimize: far LOD (~5k tris) -> dance-01.lod1.glb ==="
$GLTF optimize "$RIGGED" "$FINAL_DIR/dance-01.lod1.glb" \
  --simplify-ratio 0.10 --simplify-error 0.06 --texture-compress webp --texture-size 384 --compress meshopt \
  --flatten false --join false --instance false --palette false --resample true --prune true

echo ""
echo "=== validate ==="
$GLTF validate "$FINAL_DIR/dance-01.glb" || true
$GLTF validate "$FINAL_DIR/dance-01.lod1.glb" || true

echo ""
echo "=== inspect dance-01.glb ==="
$GLTF inspect "$FINAL_DIR/dance-01.glb" | grep -A3 "glPrimitives\|ANIMATIONS\|^info:" || true
echo "=== inspect dance-01.lod1.glb ==="
$GLTF inspect "$FINAL_DIR/dance-01.lod1.glb" | grep -A3 "glPrimitives\|ANIMATIONS\|^info:" || true

echo ""
echo "wrote $FINAL_DIR/dance-01.glb and $FINAL_DIR/dance-01.lod1.glb"
