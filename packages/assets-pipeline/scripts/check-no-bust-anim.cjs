#!/usr/bin/env node
/**
 * Build guard for build-dance.sh: fails if any animation channel in a (non-compressed) .glb moves a
 * node whose name mentions a bust/breast joint. The dancers' clip is the Mixamo "Hip Hop Dancing"
 * body motion plus (for annie) baked hair swing; no soft-tissue secondary motion is wanted, so none
 * may exist.
 *
 * Blender's glTF exporter, run with `export_force_sampling`, writes a channel for EVERY joint, so a
 * bust joint nothing drives still gets a track, holding its bind value on every frame. That is not
 * motion and is allowed; a track whose values ever differ from its first key is not, and fails the
 * build. Reads only the GLB's own JSON and BIN chunks, so it runs on the build dir rigged.glb (before
 * meshopt compression), not on the shipped files.
 *
 * Usage: node scripts/check-no-bust-anim.cjs <file.glb>
 */
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: check-no-bust-anim.cjs <file.glb>');
  process.exit(1);
}
const buf = fs.readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const COMPONENTS = { SCALAR: 1, VEC3: 3, VEC4: 4 };

function read(accessorIdx) {
  const a = json.accessors[accessorIdx];
  const v = json.bufferViews[a.bufferView];
  const n = COMPONENTS[a.type];
  const base = binStart + (v.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let i = 0; i < a.count * n; i++) out.push(buf.readFloatLE(base + i * 4));
  return { n, data: out, count: a.count };
}

let tracks = 0, constant = 0;
const moving = [];
for (const anim of json.animations || []) {
  for (const ch of anim.channels) {
    const name = json.nodes[ch.target.node].name || '';
    if (!/bust|breast/i.test(name)) continue;
    tracks++;
    const { n, data, count } = read(anim.samplers[ch.sampler].output);
    let dev = 0;
    for (let i = 1; i < count; i++) for (let k = 0; k < n; k++) dev = Math.max(dev, Math.abs(data[i * n + k] - data[k]));
    if (dev > 1e-5) moving.push(`${name}.${ch.target.path} (deviation ${dev.toExponential(2)})`);
    else constant++;
  }
}
if (moving.length) {
  console.error(`${file}: bust joints MOVE in the clip: ${moving.join(', ')}`);
  process.exit(1);
}
console.log(`ok: ${file}: ${tracks} bust-joint tracks, all ${constant} constant (bind value held); none move`);
