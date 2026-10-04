#!/usr/bin/env node
/**
 * Detaches every node that references a named mesh from a non-binary glTF's scene graph, in
 * place — used by build-dance.sh to drop the Mixamo "with skin" export's `Beta_Joints` node, a
 * joint-visualization overlay mesh (small marker geometry at every bone, meant for Mixamo's own
 * rigging preview) that ships alongside the real `Beta_Surface` body mesh in the same FBX and
 * would otherwise render as clutter stuck to the dancer's skeleton.
 *
 * Deliberately does NOT renumber/delete array entries (nodes/meshes/materials/accessors/skins) —
 * only removes the node's index from whichever node's `children` array (or `scene.nodes`)
 * referenced it. glTF tolerates unreferenced entries sitting in their arrays; three.js's
 * GLTFLoader (and gltf-transform's own `prune` command, run right after this in build-dance.sh)
 * only materializes what the scene graph actually reaches. This keeps the edit a few lines of
 * JSON surgery instead of a full accessor/bufferView reindex.
 *
 * Usage: node scripts/strip-mesh-node.cjs <in-out.gltf> <meshName>
 */
const fs = require('fs');

const [, , file, meshName] = process.argv;
if (!file || !meshName) {
  console.error('usage: strip-mesh-node.cjs <in-out.gltf> <meshName>');
  process.exit(1);
}

const gltf = JSON.parse(fs.readFileSync(file, 'utf8'));

const meshIdx = (gltf.meshes || []).findIndex((m) => m.name === meshName);
if (meshIdx === -1) {
  console.error(`no mesh named "${meshName}" found — nothing to strip (meshes: ${(gltf.meshes || []).map((m) => m.name).join(', ')})`);
  process.exit(1);
}

const nodeIdxs = (gltf.nodes || []).reduce((acc, n, i) => (n.mesh === meshIdx ? [...acc, i] : acc), []);
if (nodeIdxs.length === 0) {
  console.error(`mesh "${meshName}" (index ${meshIdx}) is not referenced by any node — nothing to strip`);
  process.exit(1);
}

let removed = 0;
for (const node of gltf.nodes || []) {
  if (!node.children) continue;
  const before = node.children.length;
  node.children = node.children.filter((c) => !nodeIdxs.includes(c));
  removed += before - node.children.length;
}
for (const scene of gltf.scenes || []) {
  const before = scene.nodes.length;
  scene.nodes = scene.nodes.filter((n) => !nodeIdxs.includes(n));
  removed += before - scene.nodes.length;
}

if (removed === 0) {
  console.error(`found node(s) ${nodeIdxs.join(',')} for mesh "${meshName}" but none were referenced as a child/scene-root — nothing changed`);
  process.exit(1);
}

fs.writeFileSync(file, JSON.stringify(gltf));
console.log(`stripped ${removed} reference(s) to node(s) [${nodeIdxs.join(',')}] (mesh "${meshName}") from ${file}`);
