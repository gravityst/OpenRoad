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
  ['handling', 'keys steer like a driver would, and the car straightens itself'],
  ['catalog', 'every car matches the figures the garage quotes'],
  ['smooth', 'the car moves speed x frame time every frame, at any frame rate'],
  ['collision', 'buildings are solid and can never add energy'],
  ['damage', 'damage only ever takes capability away'],
  ['carcrash', 'cars are solid against each other and both take the damage'],
  ['goals', 'every challenge is on a road, every race is winnable, saves survive'],
  ['debris', 'parts that fall off tumble, land, and never gain energy'],
  ['model', 'imported cars match the rig, and a missing one is harmless'],
  ['cars', 'the car models look like cars and still come apart where damage expects'],
  ['traffic', 'the other cars behave like traffic'],
  ['drift', 'sideways scores, straight does not, and the detector never flickers'],
  ['atmosphere', 'roads are sharp and seamless, and the air hides the edge of the world'],
  ['brand', 'every name in the game is invented'],
  ['nature', 'trees, rocks and grass grow where they should and cost what they say'],
  ['calm', 'a crash is a solid, harmless bump: nothing burns, breaks or slows down'],
  ['net', 'remote cars move smoothly, and old and new pages can both still play'],
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
