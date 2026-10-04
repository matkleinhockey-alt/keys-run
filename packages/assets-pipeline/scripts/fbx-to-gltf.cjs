#!/usr/bin/env node
/**
 * Thin CLI shim around the `fbx2gltf` npm package (a devDependency of this package — see
 * package.json's description for why it's installed rather than `pnpm dlx`'d like
 * @gltf-transform/cli: it ships a native per-OS binary under node_modules/fbx2gltf/bin/<OS>/ and
 * exposes no bin entry of its own, so there's nothing for `pnpm dlx` to execute).
 *
 * Usage: node scripts/fbx-to-gltf.cjs <input.fbx> <output.gltf|.glb> [extra FBX2glTF args...]
 * Used by build-dance.sh to get Mixamo's `Hip Hop Dancing.fbx` into glTF before gltf-transform
 * (which has no FBX importer) takes over for cleanup/compression.
 */
const convert = require('fbx2gltf');

const [, , input, output, ...rest] = process.argv;
if (!input || !output) {
  console.error('usage: fbx-to-gltf.cjs <input.fbx> <output.gltf|.glb> [extra FBX2glTF args...]');
  process.exit(1);
}

convert(input, output, rest)
  .then((written) => console.log(`wrote ${written}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
