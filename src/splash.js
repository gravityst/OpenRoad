/**
 * The Gravity Studios splash.
 *
 * A classic script, not a module, and loaded before main.js on purpose: it runs
 * the moment the page parses, while the game's own modules (three.js alone is
 * over a megabyte) are still downloading. So the splash is the first thing on
 * screen and it covers the load rather than adding to it.
 *
 * It never blocks the game. main.js boots underneath exactly as before; the
 * splash is an overlay that removes itself. If the logo cannot load, there is no
 * splash at all rather than a broken one.
 *
 * Kids reload a lot. The full sequence plays once per browser session; a reload
 * after that gets a short version. Any key, click or tap skips, and the key that
 * skips is swallowed so it cannot also press a button on the title screen
 * behind it. `?nosplash` skips it entirely, for testing.
 */
(function () {
  'use strict';

  var FULL_MS = 4300;           // when the outro starts, at --k = 1
  var QUICK_K = 0.42;           // timeline scale for a repeat viewing

  var el = document.getElementById('splash');
  if (!el) return;
  // When each stage actually happened, in ms since navigation — so timing can
  // be checked from outside without racing the page.
  var stamps = { script: now() };
  function now() { return Math.round(window.performance ? performance.now() : 0); }

  var query = String(location.search) + String(location.hash);
  if (/nosplash/i.test(query) || navigator.webdriver) { finish(); return; }

  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var seen = false;
  try {
    seen = sessionStorage.getItem('gravity.splash') === '1';
    sessionStorage.setItem('gravity.splash', '1');
  } catch (e) { /* private mode: every load is a first viewing, which is fine */ }

  var k = seen ? QUICK_K : 1;
  el.style.setProperty('--k', String(k));
  if (reduced) el.classList.add('is-reduced');
  if (seen) el.classList.add('is-quick');

  // Dust in the light. CSS-animated so it drifts on the compositor and keeps
  // moving while the game's world build stalls the main thread.
  var motes = el.querySelector('.splash__motes');
  if (motes && !reduced) {
    for (var i = 0; i < 26; i++) {
      var m = document.createElement('i');
      m.className = 'splash__mote';
      var s = 1 + Math.random() * 1.8;
      m.style.left = (8 + Math.random() * 84).toFixed(1) + '%';
      m.style.top = (14 + Math.random() * 76).toFixed(1) + '%';
      m.style.setProperty('--s', s.toFixed(2) + 'px');
      m.style.setProperty('--a', (0.25 + Math.random() * 0.5).toFixed(2));
      m.style.setProperty('--dx', ((Math.random() * 2 - 1) * 40).toFixed(0) + 'px');
      m.style.setProperty('--dy', (-(20 + Math.random() * 60)).toFixed(0) + 'px');
      m.style.setProperty('--t', (6 + Math.random() * 7).toFixed(1) + 's');
      m.style.setProperty('--d', (Math.random() * 1.2 * k).toFixed(2) + 's');
      motes.appendChild(m);
    }
  }

  var layers = Array.prototype.slice.call(el.querySelectorAll('.splash__part img'));
  var started = false;
  var leaving = false;
  var outTimer = 0;
  var held = false;

  function go() {
    if (started) return;
    started = true;
    stamps.go = now();
    el.classList.add('is-go');
    outTimer = setTimeout(function () { if (!held) leave(false); }, FULL_MS * k);
  }

  function leave(fast) {
    if (leaving) return;
    leaving = true;
    stamps.leave = now();
    clearTimeout(outTimer);
    // Hand the keyboard back the moment the fade starts, not when the element
    // is finally removed: the game's world build blocks timers, and the removal
    // was measured landing ~0.8 s late — long enough for a kid's first press of
    // W to vanish into an invisible splash.
    window.removeEventListener('keydown', onKey, true);
    el.classList.add(fast ? 'is-skip' : 'is-out');
    setTimeout(finish, fast ? 380 : 800 * Math.max(k, 0.6));
  }

  function finish() {
    window.removeEventListener('keydown', onKey, true);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    window.__splashDone = true;
    if (stamps) stamps.done = now();
    try { window.dispatchEvent(new Event('splashdone')); } catch (e) { /* very old browser */ }
  }

  // Capture phase on window, so this runs before any listener the game adds,
  // and stopImmediatePropagation keeps the skipping key away from the menus.
  function onKey(e) {
    if (e.metaKey || e.ctrlKey) return;   // leave browser shortcuts alone
    e.preventDefault();
    e.stopImmediatePropagation();
    leave(true);
  }
  window.addEventListener('keydown', onKey, true);
  el.addEventListener('pointerdown', function (e) { e.preventDefault(); leave(true); });

  // The ambience and the drifting dust come up on the very first frame, so
  // there is never a dead black screen, even on a slow connection.
  el.classList.add('is-live');
  stamps.live = now();

  // The reveal starts once every layer has LOADED. Not img.decode(): its
  // promise resolves on a task that queued behind the game's world build, a
  // single ~1.5 s stretch of main-thread work that starts right after
  // three.js arrives, so the reveal sat on a black screen waiting for the very
  // load it is meant to cover. Load events fire first (the layers are tiny and
  // preloaded — measured at 26 ms). If a layer fails, show nothing rather than
  // a logo with a piece missing.
  var pending = layers.length;
  function loaded() { if (--pending <= 0) go(); }
  function failed() { leave(true); }
  layers.forEach(function (img) {
    if (img.complete && img.naturalWidth > 0) { loaded(); return; }
    if (img.complete) { failed(); return; }
    img.addEventListener('load', loaded, { once: true });
    img.addEventListener('error', failed, { once: true });
  });
  if (!layers.length) go();
  // And never wait forever on a slow connection.
  setTimeout(go, 1800);

  // For looking at a single frame of the sequence without it leaving.
  window.__splash = {
    stamps: stamps,
    hold: function () { held = true; clearTimeout(outTimer); },
    skip: function () { leave(true); },
  };
})();
