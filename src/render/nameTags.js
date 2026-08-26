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
 */

import * as THREE from 'three';

const MAX_TAGS = 14;            // nearest N; a busy room must not become a wall of text
const FAR = 320;                // past this a tag is unreadable anyway
const EDGE = 46;                // px inset for off-screen arrows

const CSS = `
.ortag-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:9}
.ortag{position:absolute;left:0;top:0;will-change:transform;transform-origin:50% 100%}
.ortag__in{display:flex;flex-direction:column;align-items:center;transform-origin:50% 100%}
.ortag__name{font:600 13px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#eaf6ee;background:rgba(10,16,12,.62);border:1px solid rgba(126,242,154,.45);
  border-radius:5px;padding:2px 7px;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.9);backdrop-filter:blur(2px)}
.ortag__dist{font:500 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#7ef29a;text-shadow:0 1px 3px rgba(0,0,0,.95);margin-top:2px}
.ortag__stem{width:1px;height:10px;background:linear-gradient(rgba(126,242,154,.7),transparent)}
.orarrow{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.orarrow__tri{position:absolute;left:-9px;top:-9px;width:0;height:0;
  border-left:9px solid transparent;border-right:9px solid transparent;
  border-bottom:16px solid #7ef29a;filter:drop-shadow(0 1px 3px rgba(0,0,0,.9))}
.orarrow__lbl{position:absolute;transform:translate(-50%,-50%);
  font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ef29a;
  text-shadow:0 1px 3px rgba(0,0,0,.95);white-space:nowrap}
`;

export function createNameTags(root, opts = {}) {
  const layer = document.createElement('div');
  layer.className = 'ortag-layer';
  const style = document.createElement('style');
  style.textContent = CSS;
  layer.appendChild(style);
  (root || document.body).appendChild(layer);

  const tags = [];              // pooled DOM, never rebuilt per frame
  const arrows = [];
  const v = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let w = 1, h = 1;
  let showTags = opts.showTags !== false;
  let showArrows = opts.showArrows !== false;

  function mkTag() {
    const el = document.createElement('div');
    el.className = 'ortag';
    const inner = document.createElement('div');
    inner.className = 'ortag__in';
    const name = document.createElement('div');
    name.className = 'ortag__name';
    const dist = document.createElement('div');
    dist.className = 'ortag__dist';
    const stem = document.createElement('div');
    stem.className = 'ortag__stem';
    inner.append(name, dist, stem);
    el.appendChild(inner);
    layer.appendChild(el);
    const t = { el, inner, name, dist, txt: '', dtxt: '', shown: false };
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
    const a = { el, lbl, txt: '', shown: false };
    arrows.push(a);
    return a;
  }

  function setSize(width, height) { w = width; h = height; }

  function show(o, on) {
    if (o.shown === on) return;
    o.shown = on;
    o.el.style.display = on ? '' : 'none';
  }

  /**
   * `cars` is the remote pool from net/room.js. Nothing here writes to it.
   */
  function update(camera, cars) {
    if (!cars || !cars.length || (!showTags && !showArrows)) {
      for (const t of tags) show(t, false);
      for (const a of arrows) show(a, false);
      return;
    }
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);

    // Nearest first, so the cap keeps the people who matter.
    const live = [];
    for (const c of cars) {
      if (!c.active || c.fade <= 0) continue;
      const dx = c.x - camPos.x, dz = c.z - camPos.z;
      c.dist = Math.sqrt(dx * dx + dz * dz);
      live.push(c);
    }
    live.sort((a, b) => a.dist - b.dist);
    if (live.length > MAX_TAGS) live.length = MAX_TAGS;

    let ti = 0, ai = 0;
    const cx = w * 0.5, cy = h * 0.5;

    for (const c of live) {
      v.set(c.x, c.y + 1.55, c.z);          // roof height plus a little
      v.project(camera);
      // A point behind the camera comes back with w negative, which flips x and
      // y and pushes z past 1. Checking z is the cheap, reliable test.
      const behind = v.z > 1;
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const onScreen = !behind && sx > 0 && sx < w && sy > 0 && sy < h && c.dist < FAR;

      if (onScreen && showTags) {
        const t = tags[ti] || mkTag();
        ti++;
        show(t, true);
        // The renderer overwrites the outer transform every frame, so scale and
        // opacity live on the inner span — anything set on the outer element
        // would be destroyed on the next tick.
        t.el.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
        const k = Math.max(0.55, Math.min(1, 26 / Math.max(1, c.dist)));
        const fade = c.fade * (c.dist > FAR * 0.75
          ? 1 - (c.dist - FAR * 0.75) / (FAR * 0.25) : 1);
        // Quantised so a car at a steady distance stops invalidating layout
        // 60 times a second for changes nobody can see.
        t.inner.style.transform = `translate(-50%,-100%) scale(${k.toFixed(2)})`;
        t.inner.style.opacity = (Math.round(fade * 20) / 20).toFixed(2);
        const nm = c.name || ('Driver-' + c.id);
        if (nm !== t.txt) { t.name.textContent = nm; t.txt = nm; }   // textContent, never innerHTML
        const dt = c.dist < 1000 ? (c.dist | 0) + ' m' : (c.dist / 1000).toFixed(1) + ' km';
        if (dt !== t.dtxt) { t.dist.textContent = dt; t.dtxt = dt; }
      } else if (showArrows) {
        // Off screen: pin an arrow to the edge pointing at them. This is the
        // part that actually answers "where is everybody" — without it, finding
        // a friend on a map this size is a matter of luck.
        const a = arrows[ai] || mkArrow();
        ai++;
        show(a, true);
        let dx = sx - cx, dy = sy - cy;
        if (behind) { dx = -dx; dy = -dy; }   // un-flip the mirrored projection
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        // Clamp to the rectangle inset from the edge rather than a circle, so
        // arrows sit along the frame the way the eye expects.
        const sxr = (cx - EDGE) / Math.abs(dx || 1e-6);
        const syr = (cy - EDGE) / Math.abs(dy || 1e-6);
        const r = Math.min(sxr, syr);
        const px = cx + dx * r, py = cy + dy * r;
        const ang = Math.atan2(dy, dx) + Math.PI / 2;   // triangle points "up"
        a.el.style.transform =
          `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) rotate(${ang.toFixed(3)}rad)`;
        a.el.style.opacity = (Math.round(c.fade * 20) / 20).toFixed(2);
        const nm = (c.name || ('Driver-' + c.id)) + '  ' +
          (c.dist < 1000 ? (c.dist | 0) + 'm' : (c.dist / 1000).toFixed(1) + 'km');
        if (nm !== a.txt) { a.lbl.textContent = nm; a.txt = nm; }
        // Counter-rotate the label so text stays upright whatever the arrow does.
        a.lbl.style.transform =
          `translate(-50%,-50%) rotate(${(-ang).toFixed(3)}rad) translate(0,26px)`;
      }
    }
    for (let i = ti; i < tags.length; i++) show(tags[i], false);
    for (let i = ai; i < arrows.length; i++) show(arrows[i], false);
  }

  return {
    element: layer,
    update, setSize,
    setVisible(on) { layer.style.display = on ? '' : 'none'; },
    setShowTags(on) { showTags = !!on; },
    setShowArrows(on) { showArrows = !!on; },
    dispose() { layer.remove(); tags.length = 0; arrows.length = 0; },
  };
}
