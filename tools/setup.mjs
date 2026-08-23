// Creates the dev-only node_modules/three shim.
//
// three.js is vendored and the browser resolves it through the import map in
// index.html. Node has no import map, and the vendored addons import bare
// 'three' themselves — so rewriting the specifier in the module under test is
// not enough, the resolution has to work transitively. A tiny package that
// points back at vendor/ makes every harness able to import the real thing.
//
// Nothing here ships. node_modules is gitignored.
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'node_modules/three');

if (!existsSync(join(ROOT, 'vendor/three/build/three.module.js'))) {
  console.error('vendor/three is missing — nothing to point the shim at.');
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
symlinkSync(join(ROOT, 'vendor/three/build'), join(DEST, 'build'), 'dir');
symlinkSync(join(ROOT, 'vendor/three/addons'), join(DEST, 'addons'), 'dir');
writeFileSync(join(DEST, 'package.json'), JSON.stringify({
  name: 'three',
  version: '0.185.0',
  type: 'module',
  main: './build/three.module.js',
  exports: {
    '.': './build/three.module.js',
    './addons/*': './addons/*',
    './examples/jsm/*': './addons/*',
  },
}, null, 2) + '\n');

const three = await import('three');
console.log(`node_modules/three -> vendor/three  (r${three.REVISION})`);
