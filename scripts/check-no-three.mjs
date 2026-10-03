#!/usr/bin/env node
/**
 * CI assertion (layer 4 of docs/ARCHITECTURE.md's "packages/shared must never import three.js"):
 * bundle every packages/shared entry point with esbuild, request a `--metafile`, and fail if
 * `three` appears anywhere in the resulting module graph.
 *
 * docs/ARCHITECTURE.md describes this layer as building `apps/sim` (the Node game server) with
 * esbuild. `apps/sim` doesn't exist yet in Phase 0 — only `packages/shared` and the `apps/client`
 * skeleton do — so this script bundles packages/shared's own entry points directly. When
 * `apps/sim` lands (Phase 2+) this check should additionally (or instead) bundle *that*, since
 * it's the more direct proof that no server build can pull three.js in transitively; the
 * assertion logic below (scan metafile.inputs for a three.js path) is unchanged either way.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = path.resolve(HERE, '../packages/shared/src');

const entryPoints = [
  'world/chain.ts',
  'world/depth.ts',
  'waves/index.ts',
  'rng/index.ts',
  'content/species.ts',
  'content/creatures.ts',
  'content/boats.ts',
  'content/economy.ts',
].map((p) => path.join(SHARED_SRC, p));

const result = await build({
  entryPoints,
  bundle: true,
  write: false,
  outdir: path.join(HERE, '../.no-three-out'),
  platform: 'neutral',
  format: 'esm',
  metafile: true,
  logLevel: 'silent',
});

const threeLike = /(^|[\\/])node_modules[\\/]three([\\/]|$)|(^|[\\/])three\.js([\\/]|$)/;
const offenders = Object.keys(result.metafile.inputs).filter((f) => threeLike.test(f) || f === 'three' || f.startsWith('three/'));

if (offenders.length > 0) {
  console.error('check:no-three FAILED — three.js found in the packages/shared module graph:');
  for (const f of offenders) console.error(`  ${f}`);
  console.error('\npackages/shared must never import three.js — see docs/ARCHITECTURE.md.');
  process.exit(1);
}

const moduleCount = Object.keys(result.metafile.inputs).length;
console.log(`check:no-three OK — scanned ${moduleCount} modules across ${entryPoints.length} entry points, no three.js found.`);
