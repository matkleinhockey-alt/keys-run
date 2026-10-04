#!/usr/bin/env bash
# Builds the rigged, dancing deck-crew glTF from the user's Mixamo "Hip Hop Dancing" FBX.
#
# --- What this actually ships ---
# `raw/hiphop_dancing.fbx` is a Mixamo "with skin" library export: it carries its OWN mesh
# ("Beta_Surface", the generic Mixamo "X Bot" character — confirmed by the embedded FBX strings,
# e.g. `...Mixamo\Characters\X Bot\clean.ma`), a standard `mixamorig:` skeleton, and the
# "Hip Hop Dancing" animation baked onto that skeleton. It is NOT a retarget of this project's own
# `raw/bikini_girl.glb` crew figure — that mesh has no skeleton (see docs/ASSET-LICENCES.md) and
# was never run through Mixamo's auto-rigger. So until someone does that, the dancing crew figure
# this script produces looks like Mixamo's generic X Bot mannequin (flat reddish-brown material,
# no texture — Mixamo didn't export one), NOT like the bikini_girl figure the static crew uses.
# Both assets ship side by side; see entities/crew-model/asset.ts for which one the game actually
# loads, and docs/ASSET-LICENCES.md for the full note.
#
# --- Pipeline ---
# 1. FBX2glTF (native binary, installed via the `fbx2gltf` npm devDependency — see package.json's
#    description for why that's a real dependency instead of `pnpm dlx`, unlike every other tool
#    in this pipeline) converts the FBX to a loose (non-binary) glTF + .bin.
# 2. scripts/strip-mesh-node.cjs detaches the `Beta_Joints` node from the scene graph: Mixamo's
#    "with skin" export bundles a second mesh that's just small marker geometry at every joint,
#    meant for Mixamo's own in-browser rig preview — left in, it renders as clutter stuck to the
#    dancer's skeleton. See that script's header for why this is safe without reindexing anything.
# 3. `gltf-transform prune` drops everything that was only reachable through the node just
#    detached (its mesh, material, skin, and now-orphaned accessors) — confirmed to remove exactly
#    one Node/Skin/Mesh/Primitive/Material plus their accessors, nothing from the real figure.
# 4. `gltf-transform optimize` compresses geometry+animation with meshopt and losslessly
#    resamples/dedupes animation keyframes. Deliberately run with `--simplify false` and
#    `--flatten false --join false --instance false`: meshoptimizer's simplifier and
#    gltf-transform's scene-flattening/joining are tuned for static meshes, and this project has
#    no confirmation they preserve skin weights / joint hierarchy correctly on a skinned+animated
#    character — rather than risk a silently-broken skin, this ships the figure at its native
#    ~28k-triangle resolution. See entities/crew-model/asset.ts's header for the LOD implication
#    (this asset has no distant/cheap LOD yet, unlike the static crew-01 figure — flagged there as
#    deferred work, not an oversight).
#
# Usage: ./scripts/build-dance.sh
# Writes apps/client/public/models/crew/dance-01.glb directly (single file, no LOD split — see
# above), unlike build-crew.sh which writes two LOD files into build/ for a caller to place.
set -euo pipefail
cd "$(dirname "$0")/.."

IN_RAW="raw/hiphop_dancing.fbx"
OUT_DIR="build/dance"
OUT_FINAL="../../apps/client/public/models/crew/dance-01.glb"
GLTF="pnpm dlx @gltf-transform/cli"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "=== FBX2glTF: $IN_RAW -> $OUT_DIR/raw_out/raw.gltf ==="
# fbx2gltf's wrapper requires the *parent* of its dest argument to already exist (it does its own
# realpathSync before invoking the native tool) but the native tool itself appends a `_out/`
# subdirectory for a non-binary (.gltf) destination — so the dest argument here is "$OUT_DIR/raw.gltf"
# (parent "$OUT_DIR" already made above) and the file actually lands at "$OUT_DIR/raw_out/raw.gltf".
node scripts/fbx-to-gltf.cjs "$IN_RAW" "$OUT_DIR/raw.gltf"

echo "=== stripping Beta_Joints (Mixamo's rig-preview overlay mesh) ==="
node scripts/strip-mesh-node.cjs "$OUT_DIR/raw_out/raw.gltf" Beta_Joints

echo "=== prune (drop what stripping just orphaned) ==="
$GLTF prune "$OUT_DIR/raw_out/raw.gltf" "$OUT_DIR/pruned.glb"

echo "=== optimize (meshopt geometry+animation compression, no simplify/flatten/join) ==="
$GLTF optimize "$OUT_DIR/pruned.glb" "$OUT_FINAL" \
  --compress meshopt --simplify false --flatten false --join false --instance false --palette false --resample true --prune true

echo ""
echo "=== validate ${OUT_FINAL} ==="
$GLTF validate "$OUT_FINAL" || true

echo ""
echo "=== inspect ${OUT_FINAL} ==="
$GLTF inspect "$OUT_FINAL" | grep -A3 "glPrimitives\|ANIMATIONS\|^info:" || true

echo ""
echo "wrote $OUT_FINAL"
