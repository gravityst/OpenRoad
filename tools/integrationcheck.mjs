// Checks that every module main.js expects actually exists and exports what it
// is supposed to.
//
// main.js loads the rendering and gameplay layers dynamically so a broken one
// degrades rather than white-screens. That is the right behaviour at runtime,
// but it also means a missing export fails SILENTLY into a stub — the game runs
// and the sky is just gone. This is the thing that notices.
//
// Bare 'three' specifiers do not resolve in Node, so each module is rewritten
// into a sibling temp file with the vendored path substituted, imported, and
// deleted again. Relative project imports still resolve because the temp file
// sits in the same directory as the original.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THREE_MAIN = join(ROOT, 'vendor/three/build/three.module.js');
const THREE_ADDONS = join(ROOT, 'vendor/three/addons/');

const MODULES = [
  { file: 'src/world/layout.js',      exports: ['buildWorld', 'makeTerrain', 'pointOnEdge', 'ROAD'] },
  { file: 'src/world/ground.js',      exports: ['createGround', 'SURFACES'] },
  { file: 'src/world/noise.js',       exports: ['fbm', 'ridged', 'valueNoise', 'mulberry', 'smoothstep', 'clamp', 'lerp'] },
  { file: 'src/physics/vehicle.js',   exports: ['createVehicle', 'DEFAULT_SPEC', 'DRIVE'] },
  { file: 'src/physics/collision.js', exports: ['createCollision'] },
  { file: 'src/vehicles/catalog.js',  exports: ['CARS', 'CAR_BY_ID', 'CLASSES', 'STARTER', 'specFor'] },
  { file: 'src/input/controls.js',    exports: ['createControls'] },
  { file: 'src/input/touch.js',       exports: ['createTouchControls'], optional: true },
  { file: 'src/render/terrain.js',    exports: ['createTerrain'], optional: true },
  { file: 'src/render/roads.js',      exports: ['createRoads'], optional: true },
  { file: 'src/render/city.js',       exports: ['createCity'], optional: true },
  { file: 'src/render/props.js',      exports: ['createProps'], optional: true },
  { file: 'src/render/carModel.js',   exports: ['createCarModel', 'BODY_STYLES'], optional: true },
  { file: 'src/render/sky.js',        exports: ['createSky'], optional: true },
  { file: 'src/render/effects.js',    exports: ['createEffects'], optional: true },
  { file: 'src/render/particles.js',  exports: ['createParticles'], optional: true },
  { file: 'src/ai/traffic.js',        exports: ['createTraffic'], optional: true },
  { file: 'src/game/hud.js',          exports: ['createHUD'], optional: true },
  { file: 'src/game/menus.js',        exports: ['createMenus'], optional: true },
  { file: 'src/game/audio.js',        exports: ['createAudio'], optional: true },
];

const STYLES = ['styles/base.css', 'styles/ui.css', 'styles/hud.css', 'styles/touch.css'];

let missing = 0, broken = 0, ok = 0;
const absent = [];

for (const m of MODULES) {
  const path = join(ROOT, m.file);
  if (!existsSync(path)) {
    if (m.optional) { absent.push(m.file); missing++; }
    else { console.log(`MISSING  ${m.file}  (required)`); broken++; }
    continue;
  }

  const tmp = path.replace(/\.js$/, `.__check${process.pid}.mjs`);
  try {
    const src = readFileSync(path, 'utf8')
      .replaceAll("from 'three/addons/", `from '${THREE_ADDONS}`)
      .replaceAll('from "three/addons/', `from "${THREE_ADDONS}`)
      .replaceAll("from 'three'", `from '${THREE_MAIN}'`)
      .replaceAll('from "three"', `from "${THREE_MAIN}"`);
    writeFileSync(tmp, src);
    const mod = await import(pathToFileURL(tmp).href);
    const lacks = m.exports.filter((e) => !(e in mod));
    if (lacks.length) {
      console.log(`BAD      ${m.file}  missing exports: ${lacks.join(', ')}`);
      broken++;
    } else {
      console.log(`ok       ${m.file}`);
      ok++;
    }
  } catch (err) {
    console.log(`BROKEN   ${m.file}  ${err.message.split('\n')[0]}`);
    broken++;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

for (const s of STYLES) {
  if (!existsSync(join(ROOT, s))) { absent.push(s); missing++; }
}

// index.html must point at a three.js that is actually on disk, or the game
// dies at the import map with a message that blames the wrong thing.
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const mapped = html.match(/"three":\s*"([^"]+)"/);
if (!mapped) { console.log('BAD      index.html has no "three" import-map entry'); broken++; }
else if (!existsSync(join(ROOT, mapped[1].replace(/^\.\//, '')))) {
  console.log(`BAD      index.html maps three to ${mapped[1]}, which does not exist`);
  broken++;
} else {
  console.log('ok       index.html import map');
}

console.log(`\n${ok} module(s) good, ${broken} broken, ${missing} not yet written`);
if (absent.length) console.log(`not yet written: ${absent.join(', ')}`);
process.exit(broken ? 1 : 0);
