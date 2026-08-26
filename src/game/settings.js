/**
 * Everything the player has chosen, in ONE place.
 *
 * This module exists because there were two of these — main.js and menus.js
 * each had their own SETTINGS_KEY and their own defaults object, writing to the
 * same localStorage key with DIFFERENT keys present. main.js knew about
 * timeScale and steerFeel; menus.js knew about drawDistance, traffic and
 * invertLook; neither knew about the other's. Any new setting added to one and
 * not the other produced a first-run player for whom exactly one code path saw
 * `undefined`. Both now import from here.
 *
 * KEY NAMES ARE A CONTRACT: main.js reads these straight off the object and
 * writes the same object back, so renaming one silently disconnects a control
 * from the thing it drives.
 */

export const SETTINGS_KEY = 'openroad.settings.v1';
/** Deliberately separate: clearing your graphics settings should not silently
 *  make you a different person to everyone else in the room. */
export const IDENTITY_KEY = 'openroad.identity.v1';

export const DEFAULT_SETTINGS = {
  quality: 'medium',
  post: 'medium',
  shadows: true,
  drawDistance: 3200,
  traffic: 0.55,
  time: 9.5,
  timeScale: 0.02,
  weather: 'clear',
  esc: true,
  tc: true,
  abs: true,
  steerFeel: 1,
  invertLook: false,
  sensitivity: 1.0,
  volume: 0.8,
  name: '',
  nameTags: true,
  multiplayer: true,
};

export function loadSettings() {
  const out = { ...DEFAULT_SETTINGS };
  let raw = null;
  try { raw = localStorage.getItem(SETTINGS_KEY); } catch { return out; }
  if (!raw) return out;
  try {
    const stored = JSON.parse(raw);
    // Merged over the defaults rather than returned raw, so a blob written by
    // an older build is missing keys the game now reads.
    if (stored && typeof stored === 'object') Object.assign(out, stored);
  } catch { /* corrupt value; defaults are fine */ }
  return out;
}

export function saveSettings(settings) {
  try {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { stored = {}; }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...stored, ...settings }));
  } catch { /* private browsing — the game still works, it just forgets */ }
}

/** A stable handle for this browser. A convenience, NOT an auth token — it is
 *  trivially editable, so nothing security-relevant may depend on it. */
export function identity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) { const v = JSON.parse(raw); if (v && v.id) return v.id; }
    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      (Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ id }));
    return id;
  } catch { return 'anon'; }
}

/** Offered when the player has not chosen a name, so one keypress gets them
 *  driving instead of stopping them at a form. */
export function suggestName() {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return 'Driver-' + n;
}
