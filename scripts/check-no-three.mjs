#!/usr/bin/env node
/**
 * CI assertion (layer 4 of docs/ARCHITECTURE.md's "packages/shared must never import three.js"):
 * bundle every packages/shared entry point with esbuild, request a `--metafile`, and fail if
 * `three` appears anywhere in the resulting module graph.
 *
 * Phase 2 adds the second half docs/ARCHITECTURE.md actually describes this layer as: building
 * `apps/sim` (the Node game server) itself with esbuild — the more direct proof that no server
 * *build*, not just packages/shared in isolation, can pull three.js in transitively. That check
 * bundles apps/sim/src/index.ts with `packages: 'external'` (so `ws`/`pg`/`zod` aren't pulled in
 * and bundled — they're not what we're checking for — but a bare `import 'three'` anywhere in
 * apps/sim's own source or packages/shared would still show up as an external import reference,
 * which the scan below also checks).
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = path.resolve(HERE, '../packages/shared/src');
const SIM_SRC = path.resolve(HERE, '../apps/sim/src');

const threeLike = /(^|[\\/])node_modules[\\/]three([\\/]|$)|(^|[\\/])three\.js([\\/]|$)/;

function isThreeLike(f) {
  return threeLike.test(f) || f === 'three' || f.startsWith('three/');
}

function findOffenders(metafile) {
  const offenders = Object.keys(metafile.inputs).filter(isThreeLike);
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.external && isThreeLike(imp.path)) offenders.push(`${imp.path} (external import)`);
    }
  }
  return offenders;
}

const sharedEntryPoints = [
  'world/chain.ts',
  'world/depth.ts',
  'waves/index.ts',
  'rng/index.ts',
  'content/species.ts',
  'content/creatures.ts',
  'content/boats.ts',
  'content/economy.ts',
  'sim/boat.ts',
  'sim/boat-shadow.ts',
  'sim/depth-grid.ts',
  'sim/fight.ts',
  'sim/spear.ts',
  'proto/index.ts',
].map((p) => path.join(SHARED_SRC, p));

const sharedResult = await build({
  entryPoints: sharedEntryPoints,
  bundle: true,
  write: false,
  outdir: path.join(HERE, '../.no-three-out/shared'),
  platform: 'neutral',
  format: 'esm',
  metafile: true,
  logLevel: 'silent',
});

const simResult = await build({
  entryPoints: [path.join(SIM_SRC, 'index.ts')],
  bundle: true,
  write: false,
  outdir: path.join(HERE, '../.no-three-out/sim'),
  platform: 'node',
  format: 'esm',
  packages: 'external',
  metafile: true,
  logLevel: 'silent',
});

const offenders = [...findOffenders(sharedResult.metafile), ...findOffenders(simResult.metafile)];

if (offenders.length > 0) {
  console.error('check:no-three FAILED — three.js found in the module graph:');
  for (const f of offenders) console.error(`  ${f}`);
  console.error('\npackages/shared and apps/sim must never import three.js — see docs/ARCHITECTURE.md.');
  process.exit(1);
}

const sharedModuleCount = Object.keys(sharedResult.metafile.inputs).length;
const simModuleCount = Object.keys(simResult.metafile.inputs).length;
console.log(
  `check:no-three OK — scanned ${sharedModuleCount} modules across ${sharedEntryPoints.length} packages/shared entry points ` +
    `and ${simModuleCount} modules from apps/sim/src/index.ts, no three.js found.`,
);
