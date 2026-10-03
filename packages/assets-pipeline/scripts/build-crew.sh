#!/usr/bin/env bash
# Builds the deck-crew LOD glTFs from the raw Sketchfab export.
#
# Pipeline (see docs/ARCHITECTURE.md "Art direction": "licensed packs, normalised to glTF 2.0
# through @gltf-transform/cli ... meshopt geometry") — all via gltf-transform's single `optimize`
# command: dedup/instance/palette/flatten/join, weld, simplify, prune, texture compression, and
# meshopt, in one pass.
#
# --- Why WebP, not KTX2/Basis, despite the architecture doc naming KTX2 ---
# This was actually built and shipped as KTX2/UASTC+ETC1S first (via KTX-Software's `ktx` CLI —
# see the git history of this file for that version, which worked cleanly at build time: valid
# glTF, gltf-transform's own validator reported zero errors). It was dropped after Playwright
# verification showed the figures never appeared in-browser: KTX2Loader's Basis transcoder runs
# inside a Web Worker, and in this project's sandboxed/software-WebGL test environment that
# worker's WASM module (`BASIS()` in the embedded basis_transcoder.js) never called back
# `onRuntimeInitialized` — no error, no timeout, just permanently pending (confirmed a plain
# `new Worker()` + postMessage round-trip works fine in the same browser, so it's specifically the
# Basis WASM init that hangs there, likely a software/resource constraint of that sandbox). That
# makes the asset silently invisible with zero error output, which is worse than a bigger file.
# WebP has no such risk (every target browser decodes it natively, no worker/wasm), and empirically
# compresses *smaller* than the KTX2 build did for this asset (WebP's entropy coding beats Basis's
# block-based formats for storage size, at the cost of full decompression into VRAM at render time
# instead of staying block-compressed — irrelevant at this project's < 512 MB texture budget for
# one shared pair of textures). If KTX2 is worth revisiting (e.g. once this ships to real
# hardware/hosting instead of this sandbox), swap `--texture-compress webp` for `--texture-compress
# ktx2` below and restore the KTX2Loader wiring in entities/crew-model/asset.ts (removed along with
# this change) — see docs/ASSET-LICENCES.md for the measured sizes of both.
#
# Requirements: pnpm only (`pnpm dlx @gltf-transform/cli` — gltf-transform's own WebP encoder is
# pure JS/wasm, no native toolchain to install).
#
# Usage: ./scripts/build-crew.sh <input.glb> <output-basename>
#   e.g.  ./scripts/build-crew.sh raw/bikini_girl.glb crew-01
# Writes build/<output-basename>.lod0.glb and .lod1.glb.
set -euo pipefail
cd "$(dirname "$0")/.."

IN_RAW="${1:?usage: build-crew.sh <input.glb> <output-basename>}"
NAME="${2:?usage: build-crew.sh <input.glb> <output-basename>}"
OUT_DIR="build"
mkdir -p "$OUT_DIR"

GLTF="pnpm dlx @gltf-transform/cli"

# The Sketchfab export's pivot is not at the figure's feet and is not centred on X (bbox was
# x:[0.39,0.71] y:[0,1] z:[-0.11,0.11] — off-centre and normalised to 1 unit tall, not metres).
# Re-centre once, up front, so every clone in entities/crew-model/ can scale uniformly about its
# own feet instead of each placement site hand-correcting an offset pivot.
IN="$OUT_DIR/centered.glb"
$GLTF center "$IN_RAW" "$IN" --pivot below

# LOD configs: ratio/error tuned by hand against this specific mesh (see report) — meshoptimizer's
# simplifier has a real topology-dependent floor (UV seams / non-manifold edges it won't collapse
# past), so these don't scale linearly to a different source mesh. Re-tune by running `inspect`
# after each attempt and adjusting --simplify-ratio/--simplify-error until glPrimitives lands in
# range.
build_lod() {
  local ratio="$1" error="$2" texSize="$3" outName="$4"
  $GLTF optimize "$IN" "$OUT_DIR/${outName}.glb" \
    --simplify-ratio "$ratio" --simplify-error "$error" \
    --texture-compress webp --texture-size "$texSize" --compress meshopt
  echo "wrote $OUT_DIR/${outName}.glb"
}

# Near figure: ~10-12k triangles, full-ish texture res — this is what the camera actually gets
# close to (helm view, chase cam).
build_lod 0.24 0.02 1024 "${NAME}.lod0"

# Distant figure: as few triangles as the topology lets the simplifier reach (floor was ~5.1k on
# this mesh, see report — short of the 3-4k target but still a 90% reduction), small texture.
build_lod 0.05 0.08 384 "${NAME}.lod1"

echo ""
echo "=== inspect ${NAME}.lod0.glb ==="
$GLTF inspect "$OUT_DIR/${NAME}.lod0.glb" | grep -A2 "glPrimitives\|^info:" || true
echo "=== inspect ${NAME}.lod1.glb ==="
$GLTF inspect "$OUT_DIR/${NAME}.lod1.glb" | grep -A2 "glPrimitives\|^info:" || true
