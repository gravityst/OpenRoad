// Touch controls.
//
// This is the whole game on a phone, so it gets the same care as the tyre
// model. Keyboard and gamepad live in input/controls.js; main.js reads this
// module into a plain object and hands it to controls.update(dt, touch), which
// takes the strongest value from every source. Nothing here switches modes or
// claims exclusivity — it is just one more source.
//
// THE FOUR THINGS THAT MAKE OR BREAK A TOUCH DRIVER
//
// 1. Multi-touch. The classic failure is a single-touch implementation: you
//    hold the throttle, then move your steering thumb, and the throttle drops
//    because one "current touch" got overwritten. Every control here owns its
//    own pointerId and they are completely independent, so throttle, steering,
//    handbrake and horn can all be down at once. Pointer capture keeps a finger
//    delivering events to the control it started on even after it slides off,
//    which is what makes the steering usable at full lock.
//
// 2. Analogue, self-centring steering. A left/right pair of buttons is
//    undriveable at speed. Both touch layouts measure a RELATIVE displacement
//    from wherever the thumb landed, so there is no "reach for the control"
//    moment, and the origin is dragged along at full lock so a reversal bites
//    immediately instead of after a dead sweep back across the old travel.
//
// 3. Nothing may latch on. A phone call, a notification pulling focus, or the
//    overlay being hidden mid-corner must not leave the throttle pinned. Every
//    one of those paths funnels into releaseAll().
//
// 4. Per-frame cost. read() runs every frame, so it allocates nothing, queries
//    no layout, and writes at most three CSS custom properties — and only when
//    their quantised value actually changed, which at rest is never.
//
// Steering sign follows the project convention (see physics/vehicle.js):
// right = +X, and steer > 0 turns right. On the wheel that is clockwise.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const LAYOUTS = ['wheel', 'slider', 'tilt'];

const DEFAULTS = {
  sensitivity: 1.0,

  // Steering shape. The deadzone only has to swallow thumb tremor, so it is
  // much smaller than a gamepad's; tilt gets a bigger one because a hand held
  // in the air is never still. expo > 1 buys fine control around the straight
  // ahead without giving up full lock.
  deadzone: 0.055,
  tiltDeadzone: 0.13,
  expo: 1.35,
  smoothing: 0.030,        // s; first-order lag so 60 Hz touch sampling is not visible
  centreRate: 11.0,        // 1/s; a linear return actually reaches zero, an exponential never does

  wheelLock: 78,           // degrees of wheel rotation for full lock
  sliderSpan: 0.30,        // fraction of the steer zone's width for full lock
  tiltRange: 24,           // degrees of device tilt for full lock
  invertTilt: false,

  // Pedal travel, in seconds from released to fully applied. The brake is
  // near-instant because a panic stop is a panic stop; the throttle is slower
  // so that a tap is a blip rather than a wheelspin.
  throttleAttack: 0.10, throttleRelease: 0.055,
  brakeAttack: 0.045, brakeRelease: 0.050,
  feather: 0.42,           // pedal value once the thumb has slid to the bottom of its travel
};

const WHEEL_HUB = 26;      // px; inside this radius the finger's angle is meaningless
const SLIDER_MIN = 78;     // px of travel for full lock, floor and ceiling
const SLIDER_MAX = 210;
const TILT_WAIT = 1500;    // ms to wait for a first sensor reading before giving up

const MARKUP = `
<div class="touch__steer" data-ctl="steer">
  <div class="touch__wheel">
    <div class="touch__rim"></div>
    <div class="touch__spoke touch__spoke--l"></div>
    <div class="touch__spoke touch__spoke--r"></div>
    <div class="touch__spoke touch__spoke--d"></div>
    <div class="touch__hub"></div>
    <div class="touch__mark"></div>
  </div>
  <div class="touch__slider">
    <div class="touch__track"></div>
    <div class="touch__notch"></div>
    <div class="touch__knob"></div>
  </div>
  <div class="touch__cal">
    <button type="button" tabindex="-1" class="touch__chip" data-act="centre">Centre</button>
    <button type="button" tabindex="-1" class="touch__chip" data-act="invert">Invert</button>
    <p class="touch__note" data-note>Hold the phone how you will play, then tap Centre.</p>
  </div>
</div>
<div class="touch__aux">
  <button type="button" tabindex="-1" class="touch__btn" data-ctl="camera" aria-label="Change camera">Cam</button>
  <button type="button" tabindex="-1" class="touch__btn" data-ctl="horn" aria-label="Horn">Horn</button>
  <button type="button" tabindex="-1" class="touch__btn" data-ctl="look" aria-label="Look behind">Look</button>
</div>
<div class="touch__pads">
  <button type="button" tabindex="-1" class="touch__hand" data-ctl="handbrake" aria-label="Handbrake">Hand<br>brake</button>
  <button type="button" tabindex="-1" class="touch__pad touch__pad--brake" data-ctl="brake" aria-label="Brake"><span>Brake</span></button>
  <button type="button" tabindex="-1" class="touch__pad touch__pad--gas" data-ctl="throttle" aria-label="Throttle"><span>Gas</span></button>
</div>`;

/** A phone reports a coarse pointer and nothing else. A touchscreen laptop
 *  reports both, and handing it the mobile layer would cover a screen that has
 *  a perfectly good keyboard with thumb pads nobody can reach. */
function detectTouch() {
  try {
    const fine = matchMedia('(any-pointer: fine)').matches;
    const coarse = matchMedia('(any-pointer: coarse)').matches;
    return !fine && (coarse || navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
}

function resolveHost(root) {
  if (root && root.nodeType === 1) return root;
  if (typeof root === 'string') {
    const found = document.querySelector(root);
    if (found) return found;
  }
  return document.getElementById('touch') || document.body;
}

/** deviceorientation reports in the DEVICE's frame, which does not rotate when
 *  the screen does — so in landscape the left/right tilt has moved from gamma
 *  onto beta. Rotating the (gamma, beta) pair by the screen angle covers all
 *  four orientations in one line and cannot get out of step with a rotation
 *  the page never hears about. */
function screenAngle() {
  const so = typeof screen !== 'undefined' ? screen.orientation : null;
  if (so && typeof so.angle === 'number') return so.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

export function createTouchControls(root, opts = {}) {
  const host = resolveHost(root);
  const settings = Object.assign({}, DEFAULTS, opts.settings || {});
  const isTouch = opts.force != null ? !!opts.force : detectTouch();

  let layout = LAYOUTS.includes(opts.layout) ? opts.layout : 'wheel';
  let visible = false;
  let disposed = false;

  // ---- DOM ----------------------------------------------------------------
  const el = document.createElement('div');
  el.className = 'touch is-hidden';
  el.dataset.layout = layout;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = MARKUP;
  host.appendChild(el);

  const noteEl = el.querySelector('[data-note]');

  // One record per control. `pointer` is the pointerId that currently owns it,
  // or -1; because each control has its own, any number of them can be down
  // together. Keeping these as fixed fields rather than a Map means read() can
  // touch them without allocating an iterator.
  const mk = (name) => ({
    name,
    el: el.querySelector(`[data-ctl="${name}"]`),
    pointer: -1,
    down: false,
    value: 0,
    edge: false,
    feather: 1,
    px: 0, py: 0,
    rect: null,
  });

  const steer = mk('steer');
  const gas = mk('throttle');
  const brake = mk('brake');
  const hand = mk('handbrake');
  const horn = mk('horn');
  const look = mk('look');
  const camera = mk('camera');
  const ALL = [steer, gas, brake, hand, horn, look, camera];
  const BY_NAME = Object.create(null);
  for (let i = 0; i < ALL.length; i++) BY_NAME[ALL[i].name] = ALL[i];

  const wheelEl = el.querySelector('.touch__wheel');

  // Steering geometry, kept between events so a move does not have to re-derive it.
  let steerRaw = 0;        // -1..1 straight off the finger, before curve and smoothing
  let steerOut = 0;        // what read() reports
  let wheelAng = 0;        // rad of accumulated wheel rotation
  let lastAng = 0;         // rad, previous finger angle, for unwrapping
  let originX = 0;         // px, slider origin

  // ---- pointer handling ---------------------------------------------------
  function grab(c, e) {
    // Take-over rather than ignore: rolling onto a pad with a second thumb
    // before lifting the first should not drop the input in between.
    if (c.pointer >= 0 && c.pointer !== e.pointerId) {
      try { c.el.releasePointerCapture(c.pointer); } catch { /* already gone */ }
    }
    c.pointer = e.pointerId;
    // Capture is what lets a finger keep steering after it slides off the
    // wheel, and what guarantees we hear the pointerup even if the element
    // moves or the overlay relayouts underneath it.
    try { c.el.setPointerCapture(e.pointerId); } catch { /* not supported; window listeners still cover us */ }
    c.rect = c.el.getBoundingClientRect();
    c.px = e.clientX;
    c.py = e.clientY;
    c.down = true;
    c.el.classList.add('is-on');
  }

  function release(c) {
    if (c.pointer >= 0) {
      try { c.el.releasePointerCapture(c.pointer); } catch { /* already gone */ }
    }
    c.pointer = -1;
    c.down = false;
    c.feather = 1;
    c.el.classList.remove('is-on');
    if (c === steer) { steerRaw = 0; wheelAng = 0; }
  }

  function ctlFor(id) {
    for (let i = 0; i < ALL.length; i++) if (ALL[i].pointer === id) return ALL[i];
    return null;
  }

  function steerMove(x, y) {
    const r = steer.rect;
    if (!r) return;
    if (layout === 'wheel') {
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.5;
      const dx = x - cx;
      const dy = y - cy;
      // atan2(dx, -dy) is 0 at twelve o'clock and grows clockwise, which is the
      // direction that has to mean "steer right" (+X).
      const a = Math.atan2(dx, -dy);
      if (dx * dx + dy * dy > WHEEL_HUB * WHEEL_HUB) {
        let d = a - lastAng;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        // Clamping the accumulator, not just the output, means the wheel can
        // never be wound up past lock and then need unwinding before it reacts.
        const lock = settings.wheelLock * DEG;
        wheelAng = clamp(wheelAng + d, -lock, lock);
      }
      // Track the angle even inside the hub, so dragging through the centre
      // cannot come out the far side as a full-lock flick.
      lastAng = a;
      steerRaw = wheelAng / (settings.wheelLock * DEG);
    } else {
      const span = clamp(r.width * settings.sliderSpan, SLIDER_MIN, SLIDER_MAX);
      // Drag the origin along once the finger is past full travel. Without this
      // a thumb that ran out of screen has to sweep all the way back across the
      // dead travel before the car answers.
      originX = clamp(originX, x - span, x + span);
      steerRaw = clamp((x - originX) / span, -1, 1);
    }
  }

  // The pedals are pressure pads: full on press, easing off as the thumb slides
  // DOWN from wherever it landed. Anchoring on the press point rather than on
  // the pad means where your thumb happens to touch never decides how much
  // throttle you get, and the pad's fill shows what you have on.
  function featherAt(c, y) {
    const travel = Math.max(40, (c.rect ? c.rect.height : 80) * 0.9);
    return 1 - clamp((y - c.py) / travel, 0, 1) * (1 - settings.feather);
  }

  function onDown(e) {
    if (!visible) return;
    if (!e.target || !e.target.closest) return;
    // The calibration chips sit inside the steer zone. They are ordinary
    // buttons and must keep their click, so they never reach the grab path.
    if (e.target.closest('[data-act]')) return;
    const node = e.target.closest('[data-ctl]');
    if (!node) return;
    const c = BY_NAME[node.dataset.ctl];
    if (!c) return;
    // In tilt mode the sensor owns steering. CSS also lifts pointer-events off
    // the zone, but a stuck steering input is too expensive to leave to CSS.
    if (c === steer && layout === 'tilt') return;

    // Cancels the synthetic mouse events, the scroll, the double-tap zoom and
    // the 300 ms click delay in one go.
    e.preventDefault();
    grab(c, e);

    if (c === steer) {
      const r = c.rect;
      if (layout === 'wheel') {
        lastAng = Math.atan2(e.clientX - (r.left + r.width * 0.5), -(e.clientY - (r.top + r.height * 0.5)));
        wheelAng = 0;
      } else {
        originX = e.clientX;
      }
      steerRaw = 0;
    } else if (c === gas || c === brake) {
      c.feather = 1;
    } else if (c === camera) {
      c.edge = true;      // consumed by the next read()
    }
  }

  function onMove(e) {
    const c = ctlFor(e.pointerId);
    if (!c) return;
    e.preventDefault();
    if (c === steer) steerMove(e.clientX, e.clientY);
    else if (c === gas || c === brake) c.feather = featherAt(c, e.clientY);
  }

  function onUp(e) {
    const c = ctlFor(e.pointerId);
    if (!c) return;
    e.preventDefault();
    release(c);
  }

  function releaseAll() {
    for (let i = 0; i < ALL.length; i++) {
      release(ALL[i]);
      ALL[i].value = 0;
      ALL[i].edge = false;
    }
    steerRaw = 0;
    steerOut = 0;
    wheelAng = 0;
  }

  const onContext = (e) => { e.preventDefault(); };
  const onLostFocus = () => { releaseAll(); };
  const onVisibility = () => { if (document.hidden) releaseAll(); };

  el.addEventListener('pointerdown', onDown, { passive: false });
  el.addEventListener('contextmenu', onContext);
  // Move and up go on the window as well as relying on capture: if capture is
  // refused for any reason we still hear the release, and a control that never
  // hears its release is a throttle stuck at 100%.
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp, { passive: false });
  window.addEventListener('pointercancel', onUp, { passive: false });
  window.addEventListener('blur', onLostFocus);
  document.addEventListener('visibilitychange', onVisibility);

  // A URL bar sliding away mid-corner moves the wheel out from under the thumb.
  // Re-reading the held control's rect keeps the geometry honest.
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      for (let i = 0; i < ALL.length; i++) {
        if (ALL[i].pointer >= 0) ALL[i].rect = ALL[i].el.getBoundingClientRect();
      }
    });
    ro.observe(el);
  }

  // ---- tilt ---------------------------------------------------------------
  const tilt = { listening: false, ready: false, denied: false, samples: 0, zero: 0, raw: 0 };
  let calSum = 0, calCount = 0, calUntil = 0;
  let tiltTimer = 0;
  let retryArmed = false;

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    tilt.samples++;
    const th = screenAngle() * DEG;
    const axis = e.gamma * Math.cos(th) - e.beta * Math.sin(th);

    if (calUntil && performance.now() < calUntil) {
      // Average the calibration window rather than snapshot it, so a hand that
      // twitches on the tap does not set a crooked zero.
      calSum += axis;
      calCount++;
      return;
    }
    if (calUntil) {
      tilt.zero = calCount ? calSum / calCount : axis;
      calUntil = 0;
      tilt.ready = true;
      note('');
    }
    if (!tilt.ready) { tilt.zero = axis; tilt.ready = true; }

    const v = (axis - tilt.zero) / settings.tiltRange;
    tilt.raw = clamp(settings.invertTilt ? -v : v, -1, 1);
  }

  function note(text) {
    if (noteEl) noteEl.textContent = text;
  }

  function calibrate(ms = 400) {
    calSum = 0;
    calCount = 0;
    calUntil = performance.now() + ms;
    // Drop out of "ready" for the duration, so steering self-centres through
    // the calibration rather than freezing at whatever it read last.
    tilt.ready = false;
    tilt.raw = 0;
    note('Hold still…');
  }

  function startListening() {
    if (tilt.listening) return;
    window.addEventListener('deviceorientation', onOrient);
    tilt.listening = true;
    clearTimeout(tiltTimer);
    // Permission granted is not the same as a sensor that reports. Some
    // desktops and locked-down browsers grant and then stay silent forever.
    tiltTimer = setTimeout(() => {
      if (!tilt.samples) fallback('No tilt sensor — using the slider.');
    }, TILT_WAIT);
  }

  function stopListening() {
    if (!tilt.listening) return;
    window.removeEventListener('deviceorientation', onOrient);
    tilt.listening = false;
    clearTimeout(tiltTimer);
  }

  function fallback(why) {
    stopListening();
    tilt.ready = false;
    applyLayout('slider');
    note(why);
  }

  /** iOS only hands out the sensor from inside a user gesture, so if we were
   *  called from anywhere else the request throws instead of prompting. Arming
   *  the next tap on the overlay turns that dead end into one extra tap. */
  function armRetry() {
    if (retryArmed) return;
    retryArmed = true;
    const retry = () => {
      retryArmed = false;
      el.removeEventListener('click', retry);
      if (layout === 'tilt' || tilt.denied) enableTilt();
    };
    el.addEventListener('click', retry, { once: true });
  }

  async function enableTilt() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { tilt.denied = true; return false; }
    if (typeof DOE.requestPermission === 'function') {
      let verdict = 'denied';
      try {
        verdict = await DOE.requestPermission();
      } catch {
        // Not inside a gesture. Not a refusal, so do not treat it as one.
        armRetry();
        note('Tap Centre to allow tilt steering.');
        return false;
      }
      if (verdict !== 'granted') { tilt.denied = true; return false; }
    }
    tilt.denied = false;
    tilt.samples = 0;
    startListening();
    calibrate();
    return true;
  }

  function onChip(e) {
    const chip = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!chip) return;
    if (chip.dataset.act === 'centre') calibrate();
    else if (chip.dataset.act === 'invert') {
      settings.invertTilt = !settings.invertTilt;
      tilt.raw = -tilt.raw;
      chip.classList.toggle('is-on', settings.invertTilt);
    }
  }
  el.addEventListener('click', onChip);

  // ---- per-frame ----------------------------------------------------------
  const _state = {
    throttle: 0, brake: 0, steer: 0, handbrake: 0,
    look: 0, lookBack: 0, camera: false, horn: false,
  };
  let last = 0;

  // Quantised mirrors of what the DOM has been told, so an unchanged value
  // costs nothing.
  let shownS = 1e9, shownGas = -1, shownBrake = -1;

  function curve(v, dz) {
    const a = v < 0 ? -v : v;
    if (a <= dz) return 0;
    const t = (a - dz) / (1 - dz);
    return (v < 0 ? -1 : 1) * Math.pow(t, settings.expo);
  }

  function stepPedal(c, dt, attack, releaseTime) {
    const target = c.down ? c.feather : 0;
    const span = dt / Math.max(1e-4, target > c.value ? attack : releaseTime);
    c.value += clamp(target - c.value, -span, span);
    return c.value;
  }

  function stepSteer(dt) {
    const tiltOn = layout === 'tilt' && tilt.ready;
    const held = tiltOn || steer.pointer >= 0;
    const raw = tiltOn ? curve(tilt.raw, settings.tiltDeadzone)
      : (steer.pointer >= 0 ? curve(steerRaw, settings.deadzone) : 0);
    const target = clamp(raw * settings.sensitivity, -1, 1);

    if (!held) {
      // Linear so it lands on exactly zero. An exponential return leaves a few
      // thousandths of lock in forever, and the car quietly drifts off line.
      const span = settings.centreRate * dt;
      steerOut += clamp(-steerOut, -span, span);
    } else if (settings.smoothing > 0) {
      steerOut += (target - steerOut) * Math.min(1, dt / settings.smoothing);
    } else {
      steerOut = target;
    }
    return steerOut;
  }

  function paint(s, t, b) {
    const qs = Math.round(s * 100);
    if (qs !== shownS) { shownS = qs; el.style.setProperty('--s', (qs / 100).toFixed(2)); }
    const qt = Math.round(t * 20);
    if (qt !== shownGas) { shownGas = qt; el.style.setProperty('--gas', (qt / 20).toFixed(2)); }
    const qb = Math.round(b * 20);
    if (qb !== shownBrake) { shownBrake = qb; el.style.setProperty('--brake', (qb / 20).toFixed(2)); }
  }

  /**
   * Fill `out` with this frame's touch state. Call once per frame — the frame
   * time is measured here, since the signature carries no dt.
   * `lookBack` mirrors `look` under the name controls.js uses.
   */
  function read(out) {
    const o = out || _state;
    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;              // first call, or a clock that stepped backwards
    if (dt > 0.05) dt = 0.05;           // a backgrounded tab must not teleport the wheel

    if (!visible || disposed) {
      o.throttle = 0; o.brake = 0; o.steer = 0; o.handbrake = 0;
      o.look = 0; o.lookBack = 0; o.camera = false; o.horn = false;
      return o;
    }

    o.throttle = stepPedal(gas, dt, settings.throttleAttack, settings.throttleRelease);
    o.brake = stepPedal(brake, dt, settings.brakeAttack, settings.brakeRelease);
    o.steer = stepSteer(dt);
    o.handbrake = hand.down ? 1 : 0;
    o.look = look.down ? 1 : 0;
    o.lookBack = o.look;
    o.horn = horn.down;
    o.camera = camera.edge;
    camera.edge = false;

    paint(o.steer, o.throttle, o.brake);
    return o;
  }

  // ---- api ----------------------------------------------------------------
  function applyLayout(name) {
    layout = name;
    el.dataset.layout = name;
    if (name !== 'tilt') stopListening();
    steerRaw = 0;
    wheelAng = 0;
    if (steer.pointer >= 0) release(steer);
  }

  /**
   * 'wheel' | 'slider' | 'tilt'. Returns a promise resolving to the layout
   * actually in use, which for 'tilt' may be 'slider' if the sensor is refused
   * or absent. Call it from a tap handler on iOS or the permission prompt
   * cannot open.
   */
  function setLayout(name) {
    const want = LAYOUTS.includes(name) ? name : 'wheel';
    if (want !== 'tilt') {
      applyLayout(want);
      return Promise.resolve(want);
    }
    applyLayout('tilt');
    note('Hold the phone how you will play, then tap Centre.');
    return enableTilt().then((ok) => {
      if (!ok && tilt.denied) fallback('Tilt was declined — using the slider.');
      return layout;
    });
  }

  function setVisible(b) {
    const next = !!b;
    if (next === visible) return;
    visible = next;
    el.classList.toggle('is-hidden', !visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
    // Hiding the overlay while a thumb is on the throttle would otherwise pin
    // it, because the pointerup lands on a display:none element.
    if (!visible) { releaseAll(); paint(0, 0, 0); }
    else { last = performance.now(); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseAll();
    stopListening();
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('contextmenu', onContext);
    el.removeEventListener('click', onChip);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onLostFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    if (ro) { ro.disconnect(); ro = null; }
    el.remove();
  }

  /** Which fingers are on what, for when "it steers by itself" needs an answer. */
  function debug() {
    const down = [];
    for (let i = 0; i < ALL.length; i++) if (ALL[i].pointer >= 0) down.push(ALL[i].name);
    return {
      isTouch, visible, layout, down,
      steer: { raw: +steerRaw.toFixed(3), out: +steerOut.toFixed(3), wheelDeg: +(wheelAng / DEG).toFixed(1) },
      tilt: { listening: tilt.listening, ready: tilt.ready, denied: tilt.denied,
              samples: tilt.samples, zero: +tilt.zero.toFixed(2), raw: +tilt.raw.toFixed(3) },
    };
  }

  setVisible(!!opts.visible);

  return {
    read, setVisible, setLayout, dispose, debug,
    isTouch, settings,
    calibrateTilt: calibrate,
    get layout() { return layout; },
    get visible() { return visible; },
    get element() { return el; },
    setSensitivity: (v) => { settings.sensitivity = v; },
  };
}
