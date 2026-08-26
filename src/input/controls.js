/**
 * Keyboard and gamepad input.
 *
 * Touch lives in input/touch.js and is merged by main.js, which takes the
 * STRONGEST value from every source each frame rather than switching between
 * them. Branching on a sticky "active source" field means one stray touch or a
 * phantom gamepad silently kills the keyboard for the rest of the session.
 *
 * The three defensive details below are all things that went wrong before:
 *   - a modifier keystroke (Cmd+Shift+4 and friends) stops macOS delivering
 *     keyup, so everything held during the combo latches on forever
 *   - alt-tabbing away mid-corner leaves the throttle stuck down
 *   - plenty of gamepads rest their triggers at 0.05-0.2, which with a
 *     max-of-all-sources merge is a permanent throttle nobody asked for
 */

const KEYMAP = {
  throttle:  ['KeyW', 'ArrowUp'],
  brake:     ['KeyS', 'ArrowDown'],
  left:      ['KeyA', 'ArrowLeft'],
  right:     ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  shiftUp:   ['KeyE', 'BracketRight'],
  shiftDown: ['KeyQ', 'BracketLeft'],
  camera:    ['KeyC'],
  lookBack:  ['KeyB'],
  horn:      ['KeyH'],
  lights:    ['KeyL'],
  indLeft:   ['Comma'],
  indRight:  ['Period'],
  map:       ['KeyM'],
  inspect:   ['KeyV'],
  reset:     ['KeyR'],
  pause:     ['Escape'],
};

const MODIFIERS = ['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight'];

export function createControls(opts = {}) {
  const state = {
    throttle: 0, brake: 0, steer: 0, handbrake: 0,
    shiftUp: false, shiftDown: false,
    camera: false, lookBack: 0, horn: false, lights: false,
    indLeft: false, indRight: false,
    map: false, inspect: false, reset: false, pause: false,
    usingGamepad: false,
  };

  const settings = {
    sensitivity: 1.0,
    steerSpeed: 9.5,       // rad/s of virtual wheel travel for digital input
    steerReturn: 12.0,
    deadzone: 0.10,
    triggerDeadzone: 0.18,
  };
  Object.assign(settings, opts.settings || {});

  const held = new Set();
  const pressed = new Set();

  // ---- keyboard -----------------------------------------------------------
  const onKeyDown = (e) => {
    if (e.repeat) return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) { held.clear(); return; }
    held.add(e.code);
    pressed.add(e.code);
    for (const list of Object.values(KEYMAP)) {
      if (list.includes(e.code)) { e.preventDefault(); break; }
    }
  };
  const onKeyUp = (e) => {
    held.delete(e.code);
    if (MODIFIERS.includes(e.code) || e.code === 'ShiftLeft' || e.code === 'ShiftRight') held.clear();
  };
  const onBlur = () => { held.clear(); };
  const onVisibility = () => { if (document.hidden) onBlur(); };

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  const anyHeld = (names) => names.some((n) => held.has(n));
  const anyPressed = (names) => names.some((n) => pressed.has(n));

  // ---- gamepad ------------------------------------------------------------
  let padSteer = 0, padThrottle = 0, padBrake = 0, padHandbrake = 0;
  const padPrev = {};

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { pad = pads[i]; break; }
    if (!pad) { state.usingGamepad = false; return false; }

    const dz = settings.deadzone;
    const axis = (v) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
    const tdz = settings.triggerDeadzone;
    const trig = (v) => (v < tdz ? 0 : (v - tdz) / (1 - tdz));

    padSteer = axis(pad.axes[0] || 0);
    const rt = trig(pad.buttons[7] ? pad.buttons[7].value : 0);
    const lt = trig(pad.buttons[6] ? pad.buttons[6].value : 0);
    padThrottle = Math.max(rt, pad.buttons[0] && pad.buttons[0].pressed ? 1 : 0);
    padBrake = Math.max(lt, pad.buttons[1] && pad.buttons[1].pressed ? 1 : 0);
    padHandbrake = pad.buttons[2] && pad.buttons[2].pressed ? 1 : 0;

    const edge = (i) => {
      const now = !!(pad.buttons[i] && pad.buttons[i].pressed);
      const was = padPrev[i];
      padPrev[i] = now;
      return now && !was;
    };
    if (edge(5)) pressed.add('__shiftUp');
    if (edge(4)) pressed.add('__shiftDown');
    if (edge(3)) pressed.add('__camera');
    if (edge(9)) pressed.add('Escape');
    if (edge(8)) pressed.add('__map');

    const active = Math.abs(padSteer) > 0.10 || padThrottle > 0.02 || padBrake > 0.02 || padHandbrake > 0;
    if (active) state.usingGamepad = true;
    return state.usingGamepad;
  }

  // ---- per-frame resolve --------------------------------------------------
  let steerSmooth = 0;

  /**
   * @param {number} dt seconds
   * @param {object|null} touch optional {throttle, brake, steer, handbrake, ...}
   *        from input/touch.js, merged in as just another source
   */
  function update(dt, touch) {
    const padActive = pollGamepad();

    const kbSteer = (anyHeld(KEYMAP.right) ? 1 : 0) - (anyHeld(KEYMAP.left) ? 1 : 0);
    const kbThrottle = anyHeld(KEYMAP.throttle) ? 1 : 0;
    const kbBrake = anyHeld(KEYMAP.brake) ? 1 : 0;
    const kbHand = anyHeld(KEYMAP.handbrake) ? 1 : 0;

    const tSteer = touch ? touch.steer || 0 : 0;
    const tThrottle = touch ? touch.throttle || 0 : 0;
    const tBrake = touch ? touch.brake || 0 : 0;
    const tHand = touch ? touch.handbrake || 0 : 0;

    // Steering: whichever source is deflected furthest wins. Analogue sources
    // are smoothed lightly; digital ones need a rate limit or the car is
    // undriveable, since a key is either full lock or nothing.
    let target = kbSteer;
    let analogue = false;
    if (Math.abs(tSteer) > Math.abs(target)) { target = tSteer; analogue = true; }
    if (padActive && Math.abs(padSteer) > Math.abs(target)) { target = padSteer; analogue = true; }
    target = Math.max(-1, Math.min(1, target * settings.sensitivity));

    if (analogue) {
      steerSmooth += (target - steerSmooth) * Math.min(1, dt * 22);
    } else {
      const rate = (target === 0 ? settings.steerReturn : settings.steerSpeed) * dt;
      steerSmooth += Math.max(-rate, Math.min(rate, target - steerSmooth));
    }
    state.steer = Math.max(-1, Math.min(1, steerSmooth));

    state.throttle = Math.max(kbThrottle, tThrottle, padActive ? padThrottle : 0);
    state.brake = Math.max(kbBrake, tBrake, padActive ? padBrake : 0);
    state.handbrake = Math.max(kbHand, tHand, padActive ? padHandbrake : 0);

    state.shiftUp = anyPressed(KEYMAP.shiftUp) || pressed.has('__shiftUp') || !!(touch && touch.shiftUp);
    state.shiftDown = anyPressed(KEYMAP.shiftDown) || pressed.has('__shiftDown') || !!(touch && touch.shiftDown);
    state.camera = anyPressed(KEYMAP.camera) || pressed.has('__camera') || !!(touch && touch.camera);
    state.map = anyPressed(KEYMAP.map) || pressed.has('__map');
    state.inspect = anyPressed(KEYMAP.inspect);
    state.pause = anyPressed(KEYMAP.pause);
    state.reset = anyPressed(KEYMAP.reset);
    state.lights = anyPressed(KEYMAP.lights);
    state.indLeft = anyPressed(KEYMAP.indLeft);
    state.indRight = anyPressed(KEYMAP.indRight);
    state.horn = anyHeld(KEYMAP.horn) || !!(touch && touch.horn);
    state.lookBack = anyHeld(KEYMAP.lookBack) ? 1 : 0;

    pressed.clear();
    return state;
  }

  /**
   * Drop every latched key and button. A keyup swallowed by the browser would
   * otherwise leave the throttle stuck on forever.
   */
  function reset() {
    held.clear();
    pressed.clear();
    steerSmooth = 0;
    padSteer = padThrottle = padBrake = padHandbrake = 0;
    state.throttle = state.brake = state.steer = state.handbrake = 0;
    state.shiftUp = state.shiftDown = state.camera = false;
    state.map = state.inspect = state.pause = state.reset = state.lights = false;
    state.indLeft = state.indRight = state.horn = false;
    state.lookBack = 0;
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  /** Per-source breakdown, so "the car drives itself" is diagnosable. */
  function debug() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    return {
      resolved: { throttle: state.throttle, brake: state.brake, steer: +state.steer.toFixed(3), handbrake: state.handbrake },
      keyboard: { held: Array.from(held) },
      gamepad: { connected: pads.map((p) => p.id), active: state.usingGamepad, throttle: padThrottle, brake: padBrake, steer: +padSteer.toFixed(3) },
    };
  }

  return {
    state, settings, update, reset, dispose, debug, KEYMAP,
    setSensitivity: (v) => { settings.sensitivity = v; },
  };
}
