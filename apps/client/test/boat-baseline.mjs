/**
 * Regenerates apps/client/test/boat-baseline.json — the reference trajectory that
 * boat-trajectory.test.ts asserts against.
 *
 *   node apps/client/test/boat-baseline.mjs
 *
 * Run this ONLY when the boat physics was meant to change, and read the diff it produces before
 * committing it: every number in that file is a claim about how the boat behaves, and a
 * regenerate with no explanation is the same as deleting the test.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildBaseline } from './boat-script.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'boat-baseline.json');
const data = buildBaseline();
writeFileSync(out, JSON.stringify(data));
console.log(`wrote ${out}: ${data.steps.length} steps, events ${JSON.stringify(data.events)}`);
