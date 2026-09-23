/**
 * Photo mode. P freezes the world mid-moment, hides every piece of UI, and
 * hands the camera to the player: orbit the car, pick a look, save the shot.
 *
 * Time is frozen by main.js running the simulation at dt = 0 while this is
 * active — physics, traffic, particles and skill chains all hold exactly where
 * they were, so a photo taken mid-drift is still mid-drift. Rendering carries
 * on, so the picture is live while it is being framed.
 *
 * The camera orbits the car's DRAWN pose (the interpolated one main.js renders)
 * rather than the physics car, which runs up to a step ahead and would put the
 * car off-centre in every frame. It starts from wherever the chase camera
 * already was, so entering never jumps.
 *
 * Saving draws the finished frame — post-processing included — into a 2D
 * canvas in the same task it was rendered in (after that, a WebGL canvas
 * without preserveDrawingBuffer may already be blank), applies the chosen look,
 * letterboxes if asked, adds a small mark, and either downloads a PNG or, on a
 * phone or tablet that supports it, opens the share sheet so it can go
 * straight to Photos.
 */

const LOOKS = [
  ['Natural', 'none'],
  ['Cinematic', 'contrast(1.12) saturate(1.12) sepia(0.06) brightness(0.98)'],
  ['Golden hour', 'sepia(0.3) saturate(1.35) contrast(1.06) brightness(1.04) hue-rotate(-8deg)'],
  ['Vivid', 'saturate(1.55) contrast(1.1)'],
  ['Noir', 'grayscale(1) contrast(1.35) brightness(0.96)'],
  ['Faded film', 'contrast(0.88) saturate(0.74) brightness(1.07) sepia(0.14)'],
];
const LETTERBOX = 2.39;                  // the anamorphic cinema ratio
const PITCH_MIN = -0.12, PITCH_MAX = 1.35;
const DIST_MIN = 2.6, DIST_MAX = 40;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createPhotoMode(opts = {}) {
  const canvas = opts.canvas;
  const getPose = opts.getPose || (() => null);
  const render = opts.render || (() => {});
  const isAllowed = opts.isAllowed || (() => true);
  const onToggle = opts.onToggle || (() => {});
  const root = opts.root || document.body;

  let active = false;
  let look = 0;
  let bars = false;
  let uiHidden = false;
  const orbit = { yaw: 0, pitch: 0.2, dist: 7, height: 0.6, dragging: false, px: 0, py: 0 };
  const held = Object.create(null);

  // ---- the panel -----------------------------------------------------------
  const el = document.createElement('div');
  el.className = 'photo';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Photo mode');
  el.innerHTML = `
    <div class="photo__bars" aria-hidden="true"><i></i><i></i></div>
    <div class="photo__flash" aria-hidden="true"></div>
    <div class="photo__frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="photo__panel">
      <div class="photo__title"><span class="photo__tag">Photo mode</span><span class="photo__time">Time stopped</span></div>
      <div class="photo__looks" role="radiogroup" aria-label="Look"></div>
      <div class="photo__row">
        <button type="button" class="photo__btn photo__btn--bars" aria-pressed="false">Letterbox</button>
        <button type="button" class="photo__btn photo__btn--hide">Hide panel</button>
        <button type="button" class="photo__btn photo__btn--save">Save photo</button>
        <button type="button" class="photo__btn photo__btn--exit">Drive</button>
      </div>
      <p class="photo__keys"></p>
    </div>
    <p class="photo__toast" aria-live="polite"></p>`;
  root.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const looksEl = $('.photo__looks');
  const toastEl = $('.photo__toast');
  const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  $('.photo__keys').innerHTML = touch
    ? 'Drag to orbit &middot; pinch to zoom'
    : '<kbd>Drag</kbd> or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> orbit &middot; <kbd>Scroll</kbd> zoom &middot; <kbd>Q</kbd><kbd>E</kbd> height &middot; <kbd>F</kbd> look &middot; <kbd>B</kbd> letterbox &middot; <kbd>H</kbd> hide &middot; <kbd>Enter</kbd> save &middot; <kbd>P</kbd> drive';

  const lookBtns = LOOKS.map(([name], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'photo__look';
    b.setAttribute('role', 'radio');
    b.textContent = name;
    b.addEventListener('click', () => setLook(i));
    looksEl.appendChild(b);
    return b;
  });

  function setLook(i) {
    look = (i + LOOKS.length) % LOOKS.length;
    canvas.style.filter = look ? LOOKS[look][1] : '';
    lookBtns.forEach((b, k) => b.setAttribute('aria-checked', String(k === look)));
  }
  function setBars(on) {
    bars = on;
    el.classList.toggle('has-bars', on);
    $('.photo__btn--bars').setAttribute('aria-pressed', String(on));
    layoutBars();
  }
  function layoutBars() {
    // Bars sized to the real aspect of the screen, so the gap between them is
    // exactly 2.39:1 whatever the window is.
    const W = window.innerWidth, H = window.innerHeight;
    const keep = Math.min(H, W / LETTERBOX);
    el.style.setProperty('--bar', Math.max(0, (H - keep) / 2) + 'px');
  }
  function setUiHidden(on) {
    uiHidden = on;
    el.classList.toggle('is-bare', on);
  }

  $('.photo__btn--bars').addEventListener('click', () => setBars(!bars));
  $('.photo__btn--hide').addEventListener('click', () => setUiHidden(true));
  $('.photo__btn--save').addEventListener('click', () => save());
  $('.photo__btn--exit').addEventListener('click', () => exit());
  // With the panel hidden, a tap anywhere brings it back.
  el.addEventListener('pointerdown', (e) => { if (uiHidden && e.target === el) setUiHidden(false); });

  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    el.classList.add('has-toast');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('has-toast'), 2400);
  }

  // ---- entering and leaving ------------------------------------------------
  function enter() {
    if (active || !isAllowed()) return false;
    const p = getPose();
    const cam = opts.camera;
    if (p && cam) {
      // Continue from the chase camera: work out its orbit around the car.
      const dx = cam.position.x - p.x, dz = cam.position.z - p.z;
      const dy = cam.position.y - (p.y + orbit.height);
      const flat = Math.hypot(dx, dz);
      orbit.dist = clamp(Math.hypot(flat, dy), DIST_MIN, DIST_MAX);
      orbit.yaw = Math.atan2(dx, dz);
      orbit.pitch = clamp(Math.atan2(dy, Math.max(0.01, flat)), PITCH_MIN, PITCH_MAX);
    }
    active = true;
    for (const k in held) held[k] = false;
    document.body.classList.add('is-photo');
    el.classList.add('is-on');
    setUiHidden(false);
    setLook(look);
    layoutBars();
    onToggle(true);
    return true;
  }
  function exit() {
    if (!active) return;
    active = false;
    document.body.classList.remove('is-photo');
    el.classList.remove('is-on', 'has-toast');
    canvas.style.filter = '';
    onToggle(false);
  }

  // ---- input: owned entirely while active ----------------------------------
  // Capture phase on window, so this runs before the game's own listeners, and
  // stopImmediatePropagation keeps W, S, Escape and the rest from driving,
  // pausing or opening the map underneath a frozen world.
  const ORBIT_KEYS = { KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, KeyQ: 1, KeyE: 1, Equal: 1, Minus: 1 };
  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!active) {
      if (e.code === 'KeyP' && !e.repeat && enter()) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (ORBIT_KEYS[e.code]) { held[e.code] = true; return; }
    if (e.repeat) return;
    if (e.code === 'KeyP' || e.code === 'Escape') { if (uiHidden && e.code === 'Escape') setUiHidden(false); else exit(); }
    else if (e.code === 'KeyF') setLook(look + (e.shiftKey ? -1 : 1));
    else if (e.code === 'KeyB') setBars(!bars);
    else if (e.code === 'KeyH') setUiHidden(!uiHidden);
    else if (e.code === 'Enter' || e.code === 'Space') save();
  }
  function onKeyUp(e) {
    if (!active) return;
    e.stopImmediatePropagation();
    held[e.code] = false;
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // Orbit by dragging, zoom by wheel or pinch. Listening on the canvas only, so
  // the panel's buttons are never mistaken for a drag.
  const pointers = new Map();
  let pinch0 = 0, dist0 = 0;
  function onDown(e) {
    if (!active) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not all pointers */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = orbit.dist;
    }
  }
  function onMove(e) {
    if (!active || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const nx = e.clientX, ny = e.clientY;
    if (pointers.size === 1) {
      orbit.yaw -= (nx - prev.x) * 0.0075;
      orbit.pitch = clamp(orbit.pitch + (ny - prev.y) * 0.0055, PITCH_MIN, PITCH_MAX);
    }
    prev.x = nx; prev.y = ny;
    if (pointers.size === 2 && pinch0 > 0) {
      const [a, b] = [...pointers.values()];
      orbit.dist = clamp(dist0 * pinch0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), DIST_MIN, DIST_MAX);
    }
  }
  function onUp(e) { pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = 0; }
  function onWheel(e) {
    if (!active) return;
    e.preventDefault();
    orbit.dist = clamp(orbit.dist * Math.exp(Math.sign(e.deltaY) * 0.1), DIST_MIN, DIST_MAX);
  }
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', layoutBars);

  // ---- per frame -----------------------------------------------------------
  /** Held-key orbiting. Real dt: the world is frozen, the photographer is not. */
  function update(dt) {
    if (!active) return;
    const turn = 1.4 * dt, tilt = 0.9 * dt;
    if (held.KeyA || held.ArrowLeft) orbit.yaw += turn;
    if (held.KeyD || held.ArrowRight) orbit.yaw -= turn;
    if (held.KeyW || held.ArrowUp) orbit.pitch = clamp(orbit.pitch + tilt, PITCH_MIN, PITCH_MAX);
    if (held.KeyS || held.ArrowDown) orbit.pitch = clamp(orbit.pitch - tilt, PITCH_MIN, PITCH_MAX);
    if (held.KeyE) orbit.height = clamp(orbit.height + dt * 1.2, 0.2, 4);
    if (held.KeyQ) orbit.height = clamp(orbit.height - dt * 1.2, 0.2, 4);
    if (held.Equal) orbit.dist = clamp(orbit.dist * Math.exp(-dt * 1.5), DIST_MIN, DIST_MAX);
    if (held.Minus) orbit.dist = clamp(orbit.dist * Math.exp(dt * 1.5), DIST_MIN, DIST_MAX);
  }

  /** Called by main.js right before the frame is drawn. */
  function aim(camera, ground) {
    if (!active) return;
    const p = getPose();
    if (!p || !camera) return;
    const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
    const tx = p.x, ty = p.y + orbit.height, tz = p.z;
    let cx = tx + Math.sin(orbit.yaw) * orbit.dist * cp;
    let cy = ty + orbit.dist * sp;
    let cz = tz + Math.cos(orbit.yaw) * orbit.dist * cp;
    // Never below the ground: a camera under the terrain shows the world from
    // inside, which is the ugliest possible photo.
    if (ground && ground.heightAt) {
      const gy = ground.heightAt(cx, cz) + 0.35;
      if (cy < gy) cy = gy;
    }
    camera.position.set(cx, cy, cz);
    camera.up.set(0, 1, 0);
    camera.lookAt(tx, ty, tz);
  }

  // ---- saving --------------------------------------------------------------
  let saving = false;
  function save() {
    if (!active || saving) return;
    saving = true;
    try {
      // Draw the frame and copy it in the same task: after this task ends the
      // WebGL drawing buffer may already have been handed to the compositor.
      render();
      const W = canvas.width, H = canvas.height;
      let sy = 0, sh = H;
      if (bars) { sh = Math.min(H, Math.round(W / LETTERBOX)); sy = Math.round((H - sh) / 2); }
      const out = document.createElement('canvas');
      out.width = W; out.height = sh;
      const g = out.getContext('2d');
      const css = LOOKS[look][1];
      // ctx.filter is the look baked into the pixels. Browsers without it
      // (older Safari) still get the photo, just without the look.
      if (css !== 'none' && 'filter' in g) g.filter = css;
      g.drawImage(canvas, 0, sy, W, sh, 0, 0, W, sh);
      g.filter = 'none';
      mark(g, W, sh);
      flash();
      const name = 'open-road-' + stamp() + '.png';
      out.toBlob((blob) => {
        saving = false;
        if (!blob) { toast('Could not save that one — try again'); return; }
        deliver(blob, name);
      }, 'image/png');
    } catch (err) {
      saving = false;
      console.error('[open road] photo failed:', err);
      toast('Could not save that one — try again');
    }
  }

  function mark(g, W, H) {
    // A small, quiet signature in the corner, the way games sign their photos.
    const s = Math.max(12, Math.round(H * 0.022));
    g.save();
    g.font = `700 ${s}px "Avenir Next Condensed", "Bahnschrift", "Arial Narrow", sans-serif`;
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = s * 0.5;
    g.fillStyle = 'rgba(255,255,255,0.82)';
    const pad = Math.round(s * 1.2);
    g.fillText('OPEN ROAD', W - pad, H - pad);
    g.fillStyle = 'rgba(255,194,31,0.95)';
    g.fillRect(W - pad - g.measureText('OPEN ROAD').width, H - pad - s * 1.12, s * 1.6, Math.max(2, s * 0.14));
    g.restore();
  }

  async function deliver(blob, name) {
    // On a phone or tablet, the share sheet puts it straight into Photos.
    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Open Road' });
        toast('Shared');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') { toast('Not shared'); return; }
      /* fall through to a download */
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Saved ' + name);
  }

  function flash() {
    el.classList.remove('is-flash');
    void el.offsetWidth;                       // restart the animation
    el.classList.add('is-flash');
  }
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  setLook(0);

  return {
    get active() { return active; },
    get look() { return LOOKS[look][0]; },
    enter, exit, toggle: () => (active ? exit() : enter()),
    update, aim, save,
    setLook, setBars,
    element: el,
    dispose() {
      exit();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', layoutBars);
      el.remove();
    },
  };
}
