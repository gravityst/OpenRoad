/**
 * The loading screen's behaviour: the friendly stage names, the counting
 * percentage, the rotating tips, and the error card.
 *
 * main.js drives the screen exactly as it always has — it sets #boot-fill's
 * width, writes a raw stage name into #boot-status, flags an error with
 * data-error on #boot-status, and adds .is-done to #boot when the world is
 * ready. This file only watches those, so main.js does not know it exists and
 * nothing here can stop the game from starting.
 *
 * ?holdboot keeps the screen up after the game is ready, so it can be looked
 * at; ?holdboot=62 also pins the readout at 62 %.
 */
(function () {
  'use strict';
  var boot = document.getElementById('boot');
  if (!boot) return;
  var fill = document.getElementById('boot-fill');
  var status = document.getElementById('boot-status');
  var stageName = boot.querySelector('.boot__stage-name');
  var stageCount = boot.querySelector('.boot__stage-count');
  var pctN = boot.querySelector('.boot__pct-n');
  var tipBox = boot.querySelector('.boot__tip');

  // The road starts moving on the first frame.
  boot.classList.add('is-live');

  // ---- stage names ----------------------------------------------------------
  // main.js's names are written for developers ("post-processing"). These are
  // what a player reads. Order and thresholds mirror the stage() calls in
  // main.js; an unknown name (a stage someone adds later) is shown as-is.
  var STAGES = [
    [0.00, 'starting up', 'Starting the engine'],
    [0.05, 'laying out the world', 'Laying out the world'],
    [0.18, 'grading the roads', 'Grading the roads'],
    [0.30, 'zoning the city', 'Zoning the town'],
    [0.38, 'planting', 'Planting the forests'],
    [0.44, 'making the world solid', 'Making the world solid'],
    [0.50, 'loading modules', 'Opening the garage'],
    [0.56, 'raising the sky', 'Raising the sky'],
    [0.62, 'building the ground', 'Shaping the land'],
    [0.72, 'surfacing the roads', 'Surfacing the roads'],
    [0.80, 'putting up buildings', 'Putting up buildings'],
    [0.86, 'street furniture', 'Putting up the signs'],
    [0.90, 'dust and smoke', 'Kicking up the dust'],
    [0.93, 'post-processing', 'Polishing the light'],
    [0.95, 'putting traffic on the road', 'Putting traffic on the road'],
    [0.97, 'first look around', 'Taking a first look around'],
    [0.985, 'warming up the paint shop', 'Warming up the paint shop'],
  ];
  var FRIENDLY = {};
  for (var i = 0; i < STAGES.length; i++) FRIENDLY[STAGES[i][1]] = STAGES[i][2];
  var TOTAL = STAGES.length - 1;            // 'starting up' is not a stage
  var seen = {};
  var seenCount = 0;

  function friendly(raw) {
    raw = String(raw || '').trim();
    if (FRIENDLY[raw]) return FRIENDLY[raw];
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }

  function showStage(raw) {
    if (boot.classList.contains('is-error')) return;
    if (raw && raw !== 'starting up' && !seen[raw]) { seen[raw] = true; seenCount++; }
    stageName.textContent = friendly(raw);
    var total = Math.max(TOTAL, seenCount);
    stageCount.textContent = seenCount ? two(seenCount) + ' / ' + two(total) : '';
  }

  // ---- the percentage -------------------------------------------------------
  // main.js jumps between stage thresholds; the number counts up to each one
  // rather than snapping, so it reads as progress, not a series of teleports.
  var target = 0;
  var shown = 0;
  var pinned = null;
  function readFill() {
    var w = parseFloat(fill && fill.style.width);
    if (isFinite(w)) target = Math.max(target, Math.min(100, w));
  }

  var last = 0;
  var raf = 0;
  function tick(t) {
    var dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
    last = t;
    var goal = pinned != null ? pinned : target;
    shown += (goal - shown) * Math.min(1, dt * 5);
    if (Math.abs(goal - shown) < 0.3) shown = goal;
    pctN.textContent = String(Math.round(shown));
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // ---- tips -----------------------------------------------------------------
  // Real controls, from src/input/controls.js — never a tip for a key that
  // does nothing.
  var KEY_TIPS = [
    [['W', 'A', 'S', 'D'], 'Drive with {0}{1}{2}{3}, or the arrow keys.'],
    [['Space'], 'Hold {0} for the handbrake. Flick it in a bend to swing the tail out.'],
    [['R'], 'Stuck in a field? {0} puts you back on the road, facing the right way.'],
    [['M'], '{0} opens the map. Pick a race and follow the arrow to the start line.'],
    [['C'], '{0} swaps the chase camera for the bumper camera.'],
    [['Tab'], 'Friends online? {0} shows where they are, and takes you straight to them.'],
    [['V'], '{0} lets you walk round your car. Press {0} again to drive.'],
    [['L'], '{0} switches your headlights on when the sun goes down.'],
    [['B'], 'Hold {0} to look behind you.'],
    [['E', 'Q'], '{0} and {1} change gear yourself, if you would rather.'],
  ];
  // On a phone or tablet the keyboard tips are noise — there is no keyboard.
  // These name the on-screen buttons exactly as src/input/touch.js labels them.
  var TOUCH_TIPS = [
    [['Gas', 'Brake'], 'Hold {0} to go and {1} to slow down.'],
    [['Road'], 'Stuck in a field? Tap {0} and you are back on the road, facing the right way.'],
    [['Hand brake'], 'Hold {0} in a bend to swing the tail out.'],
    [['Cam'], '{0} swaps the chase camera for the bumper camera.'],
    [['Look'], 'Hold {0} to see what is behind you.'],
  ];
  var ANY_TIPS = [
    [[], 'Near-misses, drifts, jumps and top speed chain together. Keep the chain going and the multiplier climbs.'],
    [[], 'Every level unlocks something: cash, a new paint, or a whole new car.'],
  ];
  var touchOnly = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  var TIPS = (touchOnly ? TOUCH_TIPS : KEY_TIPS).concat(ANY_TIPS);

  function tipCard(tip) {
    var card = document.createElement('div');
    card.className = 'boot__tip-card';
    var label = document.createElement('span');
    label.className = 'boot__tip-label';
    label.textContent = 'Tip';
    var text = document.createElement('p');
    text.className = 'boot__tip-text';
    // Split the template on {n} and put real <kbd> elements between the parts.
    var parts = tip[1].split(/\{(\d)\}/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) { if (parts[i]) text.appendChild(document.createTextNode(parts[i])); continue; }
      var k = document.createElement('kbd');
      k.textContent = tip[0][+parts[i]];
      text.appendChild(k);
    }
    card.appendChild(label);
    card.appendChild(text);
    return card;
  }

  var tipIndex = Math.floor(Math.random() * TIPS.length);
  var current = null;
  var tipTimer = 0;
  function nextTip() {
    var card = tipCard(TIPS[tipIndex % TIPS.length]);
    tipIndex++;
    tipBox.appendChild(card);
    // Next frame, so the transition runs from the hidden state.
    requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add('is-on'); }); });
    var old = current;
    current = card;
    if (old) {
      old.classList.remove('is-on');
      setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 600);
    }
  }
  nextTip();
  tipTimer = setInterval(nextTip, 4600);

  // ---- errors ---------------------------------------------------------------
  function showError() {
    boot.classList.add('is-error');
    boot.setAttribute('aria-busy', 'false');
    var detail = boot.querySelector('.boot__error-detail');
    if (detail) detail.textContent = status.textContent || '';
    stageName.textContent = 'Stopped';
    clearInterval(tipTimer);
  }
  var retry = boot.querySelector('.boot__retry');
  if (retry) retry.addEventListener('click', function () { location.reload(); });

  // ---- watch what main.js does ----------------------------------------------
  readFill();
  showStage(status && status.textContent);
  if (fill) new MutationObserver(readFill).observe(fill, { attributes: true, attributeFilter: ['style'] });
  if (status) {
    new MutationObserver(function () {
      if (status.hasAttribute('data-error')) showError();
      else showStage(status.textContent);
    }).observe(status, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-error'] });
  }

  var hold = /[?&]holdboot(=(\d+))?/i.exec(String(location.search));
  if (hold) {
    // main.js ends the screen with classList.add('is-done') and then
    // bootEl.remove(). Shadow remove() on this element and strip the class as
    // soon as it lands, so the screen stays.
    boot.remove = function () {};
    if (hold[2] != null) {
      pinned = Math.max(0, Math.min(100, +hold[2]));
      var at = STAGES[0];
      for (var j = 0; j < STAGES.length; j++) if (STAGES[j][0] * 100 <= pinned) at = STAGES[j];
      // Freeze the readout at the pinned point, whatever main.js does next.
      showStage = function () {};
      stageName.textContent = at[2];
      stageCount.textContent = two(Math.max(1, STAGES.indexOf(at))) + ' / ' + two(TOTAL);
      fill.style.transition = 'none';
      readFill = function () {};
      new MutationObserver(function () {
        if (fill.style.width !== pinned + '%') fill.style.width = pinned + '%';
      }).observe(fill, { attributes: true, attributeFilter: ['style'] });
      fill.style.width = pinned + '%';
    }
    new MutationObserver(function () {
      if (boot.classList.contains('is-done')) boot.classList.remove('is-done');
    }).observe(boot, { attributes: true, attributeFilter: ['class'] });
    window.__bootHeld = true;
    return;
  }

  // Stop the counter and the tips once the screen has gone.
  new MutationObserver(function () {
    if (!boot.classList.contains('is-done')) return;
    boot.setAttribute('aria-busy', 'false');
    clearInterval(tipTimer);
    setTimeout(function () { cancelAnimationFrame(raf); }, 800);
  }).observe(boot, { attributes: true, attributeFilter: ['class'] });
})();
