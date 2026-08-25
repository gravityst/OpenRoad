// Static dev server for OPEN ROAD, plus a frame-capture endpoint.
//
// The game is plain ES modules with an import map, so it needs a real HTTP
// origin — it will not load from file://. This is that origin and nothing more.
//
// /__shot exists because the preview pane only composites while it is actually
// displayed, so screenshots taken through the harness fail whenever it is not.
// POSTing a data URL here lets the page hand a rendered frame straight to disk,
// which is the only way to actually LOOK at the game from a headless session —
// and looking at it is how the worst rendering bugs in this project were found.
import { createServer } from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, '.shots');
// The harness assigns a port through PORT. Hardcoding one meant a second run
// collided with the first server still holding the socket.
const PORT = Number(process.env.PORT) || 8145;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
};

await mkdir(SHOTS, { recursive: true });

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'POST' && url.pathname === '/__shot') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      const name = (url.searchParams.get('name') || 'shot').replace(/[^a-z0-9_-]/gi, '');
      const comma = body.indexOf(',');
      const ext = body.slice(0, comma).includes('png') ? 'png' : 'jpg';
      const file = join(SHOTS, `${name}.${ext}`);
      await writeFile(file, Buffer.from(body.slice(comma + 1), 'base64'));
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end(file);
      console.log('wrote', file);
      return;
    }

    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    // Never serve anything outside the project, whatever the URL asks for.
    const full = normalize(join(ROOT, p));
    if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const s = await stat(full);
    if (s.isDirectory()) { res.writeHead(302, { Location: p + '/' }).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(await readFile(full));
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(String(err.message || err));
  }
}).listen(PORT, () => console.log(`open road on http://localhost:${PORT}`));
