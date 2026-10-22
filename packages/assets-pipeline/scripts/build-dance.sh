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
# --- Two more dancers: ./scripts/build-dance.sh stripper | annie ---
# The Pink Flamingo's stage dancers are two more runs of this same pipeline (same output directory,
# same `<name>.glb` + `<name>.lod1.glb` pair, same meshopt + WebP 1024 / 384 texture budget, same
# `gltf-transform optimize` flags, same Mixamo "Hip Hop Dancing" clip). What differs is the rig step,
# because neither model is `bikini_girl`:
#   stripper -> dance-02   raw/1312_stripper.glb, 1,352 tris, NO skeleton, sculpted mid-crouch. The
#                          T-pose Mixamo rig cannot be bent to a crouch with fixed bone lengths, so
#                          scripts/retarget-dancer.blender.py fits a Mixamo-NAMED skeleton to the
#                          mesh's own joints and skins it by distance (heat-map tore its separate
#                          clothing shells apart). Already far under the triangle budget, so the near
#                          LOD is NOT decimated; the far LOD halves it.
#   annie    -> dance-03   raw/annie_anime_girl_2.glb, 17.3k tris, already skinned to its own VRM-style
#                          skeleton, no animation. Nothing to rig: the same script just retargets the
#                          clip onto her bones (see its header for why the world-space method).
#                          Decimated to the same ~12k near / ~5k far budget as dance-01.
# Both then fail the build if any bust joint carries an animation channel (see the guard below).
#
# Usage: ./scripts/build-dance.sh [bikini|stripper|annie]     (no argument = bikini = dance-01)
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

MODEL="${1:-bikini}"
if [ "$MODEL" != "bikini" ]; then
  case "$MODEL" in
    stripper) NAME="dance-02"; NEAR_RATIO=1;    NEAR_ERR=0.02; FAR_RATIO=0.5;  FAR_ERR=0.08 ;;
    annie)    NAME="dance-03"; NEAR_RATIO=0.70; NEAR_ERR=0.02; FAR_RATIO=0.28; FAR_ERR=0.06 ;;
    *) echo "usage: build-dance.sh [bikini|stripper|annie]"; exit 2 ;;
  esac
  OUT_DIR="build/dance-$MODEL"
  RIGGED="$OUT_DIR/rigged.glb"
  rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"

  echo "=== Blender: retarget Hip Hop Dancing onto $MODEL ==="
  "$BLENDER" --background --python scripts/retarget-dancer.blender.py -- "$(pwd)/$RIGGED" "$MODEL"

  # Ratio 1 means "do not decimate": running the simplifier at 1.0 would still weld and reorder.
  simplify_args() { if [ "$1" = "1" ]; then echo "--simplify false"; else echo "--simplify-ratio $1 --simplify-error $2"; fi; }
  echo "=== optimize: near LOD -> $NAME.glb ==="
  $GLTF optimize "$RIGGED" "$FINAL_DIR/$NAME.glb" $(simplify_args "$NEAR_RATIO" "$NEAR_ERR") \
    --texture-compress webp --texture-size 1024 --compress meshopt \
    --flatten false --join false --instance false --palette false --resample true --prune true
  echo "=== optimize: far LOD -> $NAME.lod1.glb ==="
  $GLTF optimize "$RIGGED" "$FINAL_DIR/$NAME.lod1.glb" $(simplify_args "$FAR_RATIO" "$FAR_ERR") \
    --texture-compress webp --texture-size 384 --compress meshopt \
    --flatten false --join false --instance false --palette false --resample true --prune true

  echo "=== guard: nothing may animate a bust joint ==="
  node scripts/check-no-bust-anim.cjs "$RIGGED"

  for f in "$NAME.glb" "$NAME.lod1.glb"; do
    $GLTF validate "$FINAL_DIR/$f" || true
    $GLTF inspect "$FINAL_DIR/$f" | grep -A3 "glPrimitives\|ANIMATIONS\|^info:" || true
  done
  echo "wrote $FINAL_DIR/$NAME.glb and $FINAL_DIR/$NAME.lod1.glb"
  exit 0
fi

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
