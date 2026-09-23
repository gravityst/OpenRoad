/**
 * Name tags, and finding the people wearing them.
 *
 * These are DOM elements composited ABOVE the canvas, not sprites inside the
 * scene, and that is the entire point. Anything drawn into the scene goes
 * through the post chain — bloom, then ACES tone mapping, then FXAA — so white
 * text comes out grey, glyph edges get softened by an antialiaser that was
 * never meant to see them, and SpriteMaterial's default fog washes the whole
 * thing out at ~180 m in bad weather. A div has none of those problems and
 * rasterises at the device's real pixel ratio instead of the capped one.
 *
 * Two jobs, because they are the same projection maths:
 *   - a tag over every visible driver, and
 *   - an arrow at the screen edge for every driver who is NOT visible, which is
 *     the actual answer to "where is everyone?" on a map this size.
 *
 * Each player has a colour (game/party.js) and it is the same everywhere:
 * this tag's edge and dot, their arrow, their beacon, their row in the friends
 * list. A kid looking for "the orange one" finds the same orange on all four.
 * Tags used to vanish past 320 m, which is exactly when you need them; far
 * away they now keep a compact name-and-distance instead.
 */

import * as THREE from 'three';

const MAX_TAGS = 14;            // nearest N; a busy room must not become a wall of text
const COMPACT = 320;            // past this, just the name and how far away
const EDGE = 50;                // px inset for off-screen arrows

const CSS = `
.ortag-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:9;
  --ortag-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ortag{position:absolute;left:0;top:0;will-change:transform;transform-origin:50% 100%}
.ortag__in{display:flex;flex-direction:column;align-items:center;transform-origin:50% 100%}
.ortag__name{display:flex;align-items:center;gap:6px;font:800 15px/1.2 var(--ortag-font);
  background:rgba(10,14,20,.72);border:2px solid currentColor;
  border-radius:8px;padding:3px 9px 3px 7px;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.9);box-shadow:0 0 14px -2px currentColor}
.ortag__name i{width:9px;height:9px;border-radius:50%;background:currentColor;flex:0 0 auto}
.ortag__name span{color:#fff}
.ortag__dist{font:700 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.95);margin-top:2px}
.ortag__stem{width:2px;height:12px;background:linear-gradient(currentColor,transparent)}
.ortag.is-guide .ortag__name{animation:ortag-pulse 1s ease-in-out infinite}
@keyframes ortag-pulse{50%{box-shadow:0 0 22px 2px currentColor}}
.orarrow{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.orarrow__tri{position:absolute;left:-12px;top:-12px;width:0;height:0;
  border-left:12px solid transparent;border-right:12px solid transparent;
  border-bottom:22px solid currentColor;filter:drop-shadow(0 1px 3px rgba(0,0,0,.9)) drop-shadow(0 0 6px currentColor)}
.orarrow__lbl{position:absolute;transform:translate(-50%,-50%);
  font:800 13px/1 var(--ortag-font);color:#fff;background:rgba(10,14,20,.72);
  border:1px solid currentColor;border-radius:7px;padding:3px 7px;
  text-shadow:0 1px 3px rgba(0,0,0,.95);white-space:nowrap}
.orarrow.is-guide .orarrow__tri{animation:orarrow-pulse .8s ease-in-out infinite}
@keyframes orarrow-pulse{50%{transform:scale(1.25)}}
@media (prefers-reduced-motion: reduce){.ortag *,.orarrow *{animation:none!important}}
`;

const DEFAULT_CSS = '#7ef29a';

function fmt(d) {
  return d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
}

export function createNameTags(root, opts = {}) {
  const layer = document.createElement('div');
  layer.className = 'ortag-layer';
  const style = document.createElement('style');
  style.textContent = CSS;
  layer.appendChild(style);
  (root || document.body).appendChild(layer);

  const tags = [];              // pooled DOM, never rebuilt per frame
  const arrows = [];
  const live = [];              // scratch, reused
  const placed = new Float32Array(MAX_TAGS * 2);   // arrow positions this frame
  const tagAt = new Float32Array(MAX_TAGS * 2);    // tag positions this frame
  const v = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let w = 1, h = 1;
  let showTags = opts.showTags !== false;
  let showArrows = opts.showArrows !== false;
  let guideId = -1;
  // Nearest first — except the player being guided to, who is always kept,
  // however far. A comparator defined once, not a closure per frame.
  const byDistance = (a, b) => (a.id === guideId ? -1 : b.id === guideId ? 1 : a.dist - b.dist);

  function mkTag() {
    const el = document.createElement('div');
    el.className = 'ortag';
    const inner = document.createElement('div');
    inner.className = 'ortag__in';
    const name = document.createElement('div');
    name.className = 'ortag__name';
    const dot = document.createElement('i');
    const label = document.createElement('span');
    name.append(dot, label);
    const dist = document.createElement('div');
    dist.className = 'ortag__dist';
    const stem = document.createElement('div');
    stem.className = 'ortag__stem';
    inner.append(name, dist, stem);
    el.appendChild(inner);
    layer.appendChild(el);
    const t = { el, inner, label, dist, txt: '', dtxt: '', col: '', guide: false, shown: false, k: '', o: '' };
    tags.push(t);
    return t;
  }

  function mkArrow() {
    const el = document.createElement('div');
    el.className = 'orarrow';
    const tri = document.createElement('div');
    tri.className = 'orarrow__tri';
    const lbl = document.createElement('div');
    lbl.className = 'orarrow__lbl';
    el.append(tri, lbl);
    layer.appendChild(el);
    const a = { el, lbl, txt: '', col: '', guide: false, shown: false };
    arrows.push(a);
    return a;
  }

  function setSize(width, height) { w = width; h = height; }

  function show(o, on) {
    if (o.shown === on) return;
    o.shown = on;
    o.el.style.display = on ? '' : 'none';
  }

  function paint(o, css, guide) {
    if (o.col !== css) { o.el.style.color = css; o.col = css; }
    if (o.guide !== guide) { o.el.classList.toggle('is-guide', guide); o.guide = guide; }
  }

  /**
   * `cars` is the remote pool from net/room.js. Nothing here writes to it.
   * `colourOf(car)` -> { css } and `guided` (the id being guided to) are
   * optional; without them every tag is the original green.
   */
  function update(camera, cars, self, colourOf, guided = -1) {
    if (!cars || !cars.length || (!showTags && !showArrows)) {
      for (const t of tags) show(t, false);
      for (const a of arrows) show(a, false);
      return;
    }
    guideId = guided;
    camera.getWorldPosition(camPos);
    const ox = self ? self.x : camPos.x;
    const oz = self ? self.z : camPos.z;

    live.length = 0;
    for (const c of cars) {
      if (!c.active || c.fade <= 0) continue;
      const dx = c.x - ox, dz = c.z - oz;
      c.dist = Math.sqrt(dx * dx + dz * dz);
      live.push(c);
    }
    live.sort(byDistance);
    if (live.length > MAX_TAGS) live.length = MAX_TAGS;

    let ti = 0, ai = 0;
    const cx = w * 0.5, cy = h * 0.5;

    for (const c of live) {
      const col = colourOf ? colourOf(c) : null;
      const css = col && col.css ? col.css : DEFAULT_CSS;
      const guide = c.id === guideId;
      v.set(c.x, c.y + 1.6, c.z);          // roof height plus a little
      v.project(camera);
      // A point behind the camera comes back with w negative, which flips x and
      // y and pushes z past 1. Checking z is the cheap, reliable test.
      const behind = v.z > 1;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const onScreen = !behind && sx > 0 && sx < w && sy > 0 && sy < h;
      const nm = c.name || ('Driver-' + c.id);
      // Two friends in the same direction put their tags on top of each other.
      // The nearer one (placed first) keeps its spot; this one stacks above.
      let ty = sy;
      if (onScreen) {
        for (let tries = 0; tries < 6; tries++) {
          let hit = false;
          for (let j = 0; j < ti; j++) {
            if (Math.abs(tagAt[j * 2] - sx) < 120 && Math.abs(tagAt[j * 2 + 1] - ty) < 40) { hit = true; break; }
          }
          if (!hit) break;
          ty -= 42;
        }
      }

      if (onScreen && showTags) {
        const t = tags[ti] || mkTag();
        ti++;
        show(t, true);
        paint(t, css, guide);
        // The renderer overwrites the outer transform every frame, so scale and
        // opacity live on the inner span — anything set on the outer element
        // would be destroyed on the next tick.
        t.el.style.transform = `translate(${sx.toFixed(1)}px,${ty.toFixed(1)}px)`;
        tagAt[(ti - 1) * 2] = sx; tagAt[(ti - 1) * 2 + 1] = ty;
        // Never below 80%: at the old 62% floor a far tag was 9 px text.
        const k = Math.max(0.8, Math.min(1, 30 / Math.max(1, c.dist)));
        // Quantised so a car at a steady distance stops invalidating layout
        // 60 times a second for changes nobody can see.
        const ks = `translate(-50%,-100%) scale(${k.toFixed(2)})`;
        if (t.k !== ks) { t.inner.style.transform = ks; t.k = ks; }
        const os = (Math.round(c.fade * 20) / 20).toFixed(2);
        if (t.o !== os) { t.inner.style.opacity = os; t.o = os; }
        if (nm !== t.txt) { t.label.textContent = nm; t.txt = nm; }   // textContent, never innerHTML
        // Far off, the car itself is a few pixels; how far is what matters.
        const dt = c.dist < COMPACT ? fmt(c.dist) : `${fmt(c.dist)} away`;
        if (dt !== t.dtxt) { t.dist.textContent = dt; t.dtxt = dt; }
      } else if (showArrows && !onScreen) {
        // Off screen: pin an arrow to the edge pointing at them. This is the
        // part that actually answers "where is everybody" — without it, finding
        // a friend on a map this size is a matter of luck.
        const a = arrows[ai] || mkArrow();
        ai++;
        show(a, true);
        paint(a, css, guide);
        let dx = sx - cx, dy = sy - cy;
        if (behind) { dx = -dx; dy = -dy; }   // un-flip the mirrored projection
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        // Clamp to the rectangle inset from the edge rather than a circle, so
        // arrows sit along the frame the way the eye expects.
        const sxr = (cx - EDGE) / Math.abs(dx || 1e-6);
        const syr = (cy - EDGE) / Math.abs(dy || 1e-6);
        const r = Math.min(sxr, syr);
        let px = cx + dx * r, py = cy + dy * r;
        // Two friends in the same direction must not stack into one unreadable
        // arrow: slide this one along the edge until it clears the others.
        const side = sxr < syr;               // on the left/right edge
        for (let tries = 0; tries < 6; tries++) {
          let hit = false;
          for (let j = 0; j < ai - 1; j++) {
            if (Math.abs(placed[j * 2] - px) < 110 && Math.abs(placed[j * 2 + 1] - py) < 40) { hit = true; break; }
          }
          if (!hit) break;
          if (side) py = Math.min(h - EDGE, py + 44); else px = Math.min(w - EDGE, px + 120);
        }
        placed[(ai - 1) * 2] = px; placed[(ai - 1) * 2 + 1] = py;
        const ang = Math.atan2(dy, dx) + Math.PI / 2;   // triangle points "up"
        a.el.style.transform =
          `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) rotate(${ang.toFixed(3)}rad)`;
        a.el.style.opacity = (Math.round(c.fade * 20) / 20).toFixed(2);
        const lbl = `${nm}  ${fmt(c.dist)}`;
        if (lbl !== a.txt) { a.lbl.textContent = lbl; a.txt = lbl; }
        // Counter-rotate the label so text stays upright whatever the arrow does.
        a.lbl.style.transform =
          `translate(-50%,-50%) rotate(${(-ang).toFixed(3)}rad) translate(0,34px)`;
      }
    }
    for (let i = ti; i < tags.length; i++) show(tags[i], false);
    for (let i = ai; i < arrows.length; i++) show(arrows[i], false);
  }

  return {
    element: layer,
    update, setSize,
    setVisible(on) {
      const want = on ? '' : 'none';
      if (layer.style.display !== want) layer.style.display = want;
    },
    setShowTags(on) { showTags = !!on; },
    setShowArrows(on) { showArrows = !!on; },
    dispose() { layer.remove(); tags.length = 0; arrows.length = 0; },
  };
}
