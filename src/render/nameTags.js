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
 *
 * Party games (game/modes.js) add two things to a tag: a badge — IT in tag,
 * the running position in a race — and a speech bubble when that player sends
 * one of the four emotes. Your own emote gets a bubble over your own car. The
 * styles are in styles/multiplayer.css.
 */

import * as THREE from 'three';

const MAX_TAGS = 14;            // nearest N; a busy room must not become a wall of text
const COMPACT = 320;            // past this, just the name and how far away
const EDGE = 50;                // px inset for off-screen arrows

const DEFAULT_CSS = '#7ef29a';

function fmt(d) {
  return d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
}

export function createNameTags(root, opts = {}) {
  const layer = document.createElement('div');
  layer.className = 'ortag-layer';
  (root || document.body).appendChild(layer);
  // Your own car's speech bubble.
  const selfSay = document.createElement('div');
  selfSay.className = 'ortag-self';
  selfSay.hidden = true;
  const selfSayText = document.createElement('b');
  selfSay.appendChild(selfSayText);
  layer.appendChild(selfSay);
  let selfTxt = '', selfCol = '';

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
    const say = document.createElement('div');
    say.className = 'ortag__say';
    say.hidden = true;
    const sayText = document.createElement('b');
    say.appendChild(sayText);
    const name = document.createElement('div');
    name.className = 'ortag__name';
    const label = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = 'ortag__badge';
    const badgeText = document.createElement('b');
    badge.appendChild(badgeText);
    name.append(label, badge);
    const dist = document.createElement('div');
    dist.className = 'ortag__dist';
    const stem = document.createElement('div');
    stem.className = 'ortag__stem';
    inner.append(say, name, dist, stem);
    el.appendChild(inner);
    layer.appendChild(el);
    const t = {
      el, inner, label, dist, say, sayText, badgeText, txt: '', dtxt: '', col: '', guide: false, shown: false, k: '', o: '',
      stxt: '', btxt: '',
    };
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
    const a = { el, lbl, txt: '', col: '', guide: false, shown: false, it: false };
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

  /** A badge ('IT', 'P2') and a bubble on a tag; strings compared, never rebuilt. */
  function deco(t, id, games) {
    const b = games ? games.badge(id) : '';
    if (b !== t.btxt) {
      t.btxt = b;
      t.badgeText.textContent = b;
      t.el.classList.toggle('has-badge', !!b);
      t.el.classList.toggle('is-it', b === 'IT');
    }
    const w = games ? games.say(id) : '';
    if (w !== t.stxt) {
      t.stxt = w;
      t.sayText.textContent = w;
      t.say.hidden = !w;
    }
  }

  /** Your own emote, over your own car (`self` is where it is drawn). */
  const vs = new THREE.Vector3();
  function selfBubble(camera, self, games, selfId) {
    const w = games && self && selfId >= 0 ? games.say(selfId) : '';
    if (!w || !showTags) { if (!selfSay.hidden) { selfSay.hidden = true; selfTxt = ''; } return; }
    vs.set(self.x, (self.y || 0) + 1.9, self.z);
    vs.project(camera);
    if (vs.z > 1) { selfSay.hidden = true; return; }
    const sx = (vs.x * 0.5 + 0.5) * w, sy = (-vs.y * 0.5 + 0.5) * h;
    if (w !== selfTxt) {
      selfTxt = w;
      selfSayText.textContent = w;
      // Re-inserted so the pop-in animation runs for every new reaction.
      selfSay.hidden = true;
      void selfSay.offsetWidth;
    }
    const col = games.cssOf ? games.cssOf(selfId) : DEFAULT_CSS;
    if (col !== selfCol) { selfSay.style.color = col; selfCol = col; }
    selfSay.hidden = false;
    selfSay.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%)`;
  }

  /**
   * `cars` is the remote pool from net/room.js. Nothing here writes to it.
   * `colourOf(car)` -> { css } and `guided` (the id being guided to) are
   * optional; without them every tag is the original green. `games` is
   * game/modes.js ({ badge(id), say(id) }) and `selfId` this player's id, for
   * the party games' badges and bubbles; both optional.
   */
  function update(camera, cars, self, colourOf, guided = -1, games = null, selfId = -1) {
    selfBubble(camera, self, games, selfId);
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
        deco(t, c.id, games);
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
        // IT, off screen, gets a pulsing arrow: where the chaser is matters.
        const isIt = !!games && games.badge(c.id) === 'IT';
        if (a.it !== isIt) { a.el.classList.toggle('is-it', isIt); a.it = isIt; }
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
        const say = games ? games.say(c.id) : '';
        const lbl = say ? `${nm}: ${say}` : `${nm}  ${fmt(c.dist)}`;
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
