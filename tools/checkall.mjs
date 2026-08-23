// Runs every harness. One command, one verdict.
//
// The point of having six separate harnesses is that each one fails for a
// different reason and says so; the point of this file is that nobody has to
// remember all six.
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS = [
  ['integration', 'every module loads and exports what main.js expects'],
  ['ground', 'the surface the physics stands on is continuous and total'],
  ['vehicle', 'the car accelerates, stops, corners and steers the right way'],
  ['catalog', 'every car matches the figures the garage quotes'],
  ['collision', 'buildings are solid and can never add energy'],
  ['traffic', 'the other cars behave like traffic'],
  ['brand', 'every name in the game is invented'],
];

const results = [];
for (const [name, why] of CHECKS) {
  const file = resolve(HERE, `${name}check.mjs`);
  const t0 = Date.now();
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  const ms = Date.now() - t0;
  const ok = run.status === 0;
  results.push({ name, why, ok, ms, out: (run.stdout || '') + (run.stderr || '') });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(12)} ${String(ms).padStart(6)} ms   ${why}\n`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  for (const f of failed) {
    console.log(`\n${'='.repeat(70)}\n${f.name}\n${'='.repeat(70)}`);
    console.log(f.out.trim());
  }
  console.log(`\n${failed.length} of ${results.length} harnesses failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} harnesses passed in ${results.reduce((a, r) => a + r.ms, 0)} ms.`);
