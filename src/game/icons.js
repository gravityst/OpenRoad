// The game's one icon language, and its logotype.
//
// Every pictogram in the menus, the HUD and the goals overlay comes from here,
// so they share one grammar: a 24-unit grid, solid shapes with CUT corners
// rather than round ones, square line ends, and nothing thinner than 2 units —
// the finest line that survives being drawn 16 px tall on a phone. Colour is
// always currentColor, so the same glyph is amber on a race pin and white in a
// button without a second copy.
//
// Why hand-drawn and not an icon font or emoji: emoji render differently on
// every platform (the lock the garage used to show was a colour cartoon on one
// machine and a hollow box on another), and a stock set would look like every
// other web app. These are drawn to match the logotype's chamfers.
//
// Strings, not DOM: they are only ever put into markup this module wrote, and
// a string can go into innerHTML, a template literal or a CSS mask alike.

const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

// Paths first, so a caller that needs the geometry (a canvas, a mask) can have
// it without the wrapper.
export const PATHS = {
  // Motion: a heavy chevron rather than a triangle — a triangle is a media
  // player's Play, and this is a car pulling away.
  play: '<path d="M5 3h6l9 9-9 9H5l9-9z"/>',
  back: '<path d="M19 3h-6l-9 9 9 9h6l-9-9z"/>',
  next: '<path d="M8 4h4l7 8-7 8H8l7-8z"/>',
  close: '<path d="M4 7l3-3 5 5 5-5 3 3-5 5 5 5-3 3-5-5-5 5-3-3 5-5z"/>',

  // A hatchback in profile, cut from one sheet: the wheel arches are the
  // wheels' own circles removed from the body.
  car: '<path d="M2 16v-4l3-1 3-4h8l4 4 2 1v4h-2.2a3 3 0 0 0-5.6 0H9.8a3 3 0 0 0-5.6 0zM9 8.8v2.2H7.4l1.6-2.2zM11 8.8h4.4l2 2.2H11z"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
  // Folded road map, three panels, the middle one set back.
  map: '<path d="M2 5l6-2v16l-6 2z"/><path d="M9.5 3.2l5 2.2v15.4l-5-2.2z" opacity=".55"/><path d="M16 5.4l6-2.2v15.6l-6 2.2z"/>',
  trophy: '<path d="M6 2h12v6l-2 5h-8l-2-5z"/><path d="M3 4h3v4l-3-2zM21 4h-3v4l3-2z"/><path d="M10.5 13h3v4h-3z"/><path d="M7 18h10l1 4H6z"/>',
  // Three sliders, not a cog: a cog is the most generic glyph there is.
  settings: '<path d="M3 5h18v2H3zM3 11h18v2H3zM3 17h18v2H3z" opacity=".45"/><path d="M6 3h4v6H6zM14 9h4v6h-4zM8 15h4v6H8z"/>',
  // Two helmets, the nearer one solid: a racing game's word for "people".
  friends: '<path d="M11 18c0-4 2.6-7 6-7s5 2.6 5 5.5V18l-1.6 1H15v3h-4z" opacity=".55"/><path d="M1.5 14.5C1.5 9 4.6 5 9 5s6.5 3.4 6.5 7v2.5l-2 1.5H6v4H1.5zM7 9.4h6.2v2.8H7z"/>',

  // ---- challenge kinds ----
  // The squares are holes in the flag, so the chequer survives any colour.
  race: '<path d="M4 2h2v20H4z"/><path d="M7 3h13l-2 5 2 5H7zM9.6 5.5h2.6V8H9.6zM14.8 5.5h2.6V8h-2.6zM12.2 8h2.6v2.5h-2.6zM12.2 3v2.5h2.6V3zM9.6 10.5h2.6V13H9.6zM14.8 10.5h2.6V13h-2.6z"/>',
  trap: '<path d="M12 5a10 10 0 0 1 10 10v2h-3v-2a7 7 0 0 0-14 0v2H2v-2A10 10 0 0 1 12 5z"/><path d="M10.6 15.2l6.4-7 1.4 1.4-6.4 7z"/><path d="M9 14h6v6H9z"/>',
  jump: '<path d="M1 21h12L1 15z"/><path d="M8 11c3-6 8-8 13-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-dasharray="3 2.2"/><path d="M22 3.6l-.8 5-4-2.6z"/>',
  drift: '<path d="M3 20c4 0 5-6 9-6s4 4 9 4" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M3 12c4 0 5-6 9-6s4 4 9 4" fill="none" stroke="currentColor" stroke-width="2.6" opacity=".5"/>',
  token: '<path d="M12 1l9.5 5.5v11L12 23l-9.5-5.5v-11zM9 7l3 5-3 5h4l3-5-3-5z"/>',
  nav: '<path d="M12 2l8 19-8-4.5L4 21z"/>',

  // ---- the long game ----
  level: '<path d="M12 2l9 7v5l-9-7-9 7V9z"/><path d="M12 10l9 7v5l-9-7-9 7v-5z" opacity=".6"/>',
  daily: '<path d="M3 5h18v17H3z" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M3 5h18v4H3zM7 2h2.4v5H7zM14.6 2H17v5h-2.4z"/><path d="M7.4 14.6l1.8-1.8 2 2 4.6-4.6 1.8 1.8-6.4 6.4z"/>',
  streak: '<path d="M14 1L4 14h6l-2 9 12-14h-7z"/>',
  paint: '<path d="M7 2h6v4H7z"/><path d="M5 7h10l1 2v13H4V9z"/><path d="M17 4h2v2h-2zM20 2h2v2h-2zM20 6h2v2h-2z" opacity=".7"/>',
  cash: '<path d="M2 6h20v12H2zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM4 8v2h2V8zM18 14v2h2v-2z"/>',
  xp: '<path d="M12 1l3 7.5 8 .7-6 5.3 1.8 7.8L12 18l-6.8 4.3L7 14.5 1 9.2l8-.7z"/>',
  medal: '<path d="M5 1h5l3 6H8zM19 1h-5l-3 6h5z" opacity=".6"/><path d="M12 7a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 10.5l-1.4 3-3.2.3 2.4 2.1-.7 3.2 2.9-1.7 2.9 1.7-.7-3.2 2.4-2.1-3.2-.3z"/>',
  lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3h-3V7a2 2 0 0 0-4 0v3z"/><path d="M4 10h16v12H4zM11 14v4h2v-4z"/>',
  check: '<path d="M2 12.5l3-3 4.5 4.5L19 4.5l3 3L9.5 20z"/>',

  // ---- pause and race actions ----
  restart: '<path d="M12 3a9 9 0 1 1-8.5 6h3.3A6 6 0 1 0 12 6v3L6.5 4.5 12 0z"/>',
  exit: '<path d="M3 2h11v6h-3V5H6v14h5v-3h3v6H3z"/><path d="M13 10.5h5V7l5 5-5 5v-3.5h-5z"/>',
  leave: '<path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 8h8v8H8z"/>',

  // ---- touch controls ----
  camera: '<path d="M2 7h5l2-3h6l2 3h5v14H2zM12 9.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/><path d="M12 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>',
  // A rear-view mirror with an arrow pointing back through it.
  look: '<path d="M2 5h20v11H2zM4 7v7h16V7z"/><path d="M15 8.5L8 10.5l7 2z"/><path d="M10 16h4v5h-4z"/>',
  road: '<path d="M9 2h2L8 22H2zM13 2h2l7 20h-6z"/><path d="M11.2 4h1.6l.3 3h-2.2zM10.6 10h2.8l.4 4h-3.6zM10 17h4l.4 5H9.6z" opacity=".7"/>',
  handbrake: '<path d="M4 20l12-14 3 2.5L7 22.5z"/><path d="M15 3h6v6h-6z"/><path d="M2 20h8v3H2z" opacity=".55"/>',
  // Pedals, with their grip ribs cut through: tall and narrow for the
  // throttle, wide and square for the brake, as they are in a real footwell.
  pedal: '<path d="M6 2h12l2 16H4zM8 5.2v1.6h8V5.2zM8 9.2v1.6h8V9.2zM7.6 13.2v1.6h8.8v-1.6z"/><path d="M10 19h4v4h-4z"/>',
  brake: '<path d="M3 6h18l-2 14H5zM6 9.2v1.6h12V9.2zM6 13.2v1.6h12v-1.6z"/>',
};

/** An icon as markup. `name` falls back to the nav arrow, never to nothing. */
export function icon(name, cls) {
  const body = PATHS[name] || PATHS.nav;
  return svg(`<g fill="currentColor" fill-rule="evenodd">${body}</g>`, cls ? ` class="${cls}"` : '');
}

// ---- the logotype ----------------------------------------------------------
//
// OPEN ROAD, drawn rather than typeset, so it is the same letterforms on every
// machine — a CSS font stack would have given the kids on a school tablet a
// different logo from the ones at home. Seven glyphs on a 100-unit cap height:
// 22-24 unit stems, 20 unit bars, the bowls cut at 45 degrees instead of
// rounded, set in a 12 degree forward lean. One horizontal cut runs through
// every letter at the same height, which is what makes it read as a decal on
// a car rather than as a word in a font.
const GLYPH = {
  O: [70, 'M20,0H50L70,20V80L50,100H20L0,80V20Z M30,20H40L46,26V74L40,80H30L24,74V26Z'],
  P: [64, 'M0,0H44L64,20V40L44,60H24V100H0Z M24,20H36L40,24V36L36,40H24Z'],
  E: [56, 'M0,0H56V20H24V40H50V60H24V80H56V100H0Z'],
  N: [70, 'M0,0H22L48,48V0H70V100H48L22,52V100H0Z'],
  R: [66, 'M0,0H46L66,20V38L54,50L68,100H44L32,60H24V100H0Z M24,20H38L42,24V36L38,40H24Z'],
  A: [70, 'M0,100V28L28,0H42L70,28V100H46V74H24V100Z M24,54H46V32L38,22H32L24,32Z'],
  D: [68, 'M0,0H46L68,22V78L46,100H0Z M24,20H38L44,26V74L38,80H24Z'],
};
const TRACK = 10;

function setWord(text, x0, cls) {
  let x = x0, out = '';
  for (const ch of text) {
    const g = GLYPH[ch];
    if (!g) { x += 34; continue; }
    out += `<path class="${cls}" transform="translate(${x} 0)" d="${g[1]}" fill-rule="evenodd"/>`;
    x += g[0] + TRACK;
  }
  return out;
}

let maskSeq = 0;
/**
 * The logotype as SVG markup. `stacked` puts ROAD under OPEN, stepped right
 * by the lean so the two words share one slanted left edge.
 *
 * The cut is a mask rather than two half-glyphs, so the letters stay single
 * paths and the gap is exactly the same on all of them. Each call gets its
 * own mask id: two logotypes on one page sharing an id would cut the second
 * through the first's mask.
 */
export function logotype({ stacked = true, label = 'Open Road' } = {}) {
  const id = `or-cut-${++maskSeq}`;
  // skewX(-12deg) moves the foot of a 100-unit letter 21.3 units left, so the
  // box starts that far left of x=0 and every row stays inside it.
  const lean = 21.3;
  if (stacked) {
    const w = 330, h = 216;
    return `<svg class="or-logo or-logo--stacked" viewBox="${-lean - 2} -2 ${w + lean + 4} ${h + 4}" role="img" aria-label="${label}">`
      + `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-40" y="-10" width="420" height="240">`
      + '<rect x="-40" y="-10" width="420" height="240" fill="#fff"/>'
      + '<rect x="-40" y="61" width="420" height="5" fill="#000"/><rect x="-40" y="177" width="420" height="5" fill="#000"/>'
      + `</mask></defs><g transform="skewX(-12)" mask="url(#${id})">`
      + setWord('OPEN', 0, 'or-logo__open')
      + `<g transform="translate(22 116)">${setWord('ROAD', 0, 'or-logo__road')}</g>`
      + '</g></svg>';
  }
  const w = 632, h = 100;
  return `<svg class="or-logo or-logo--line" viewBox="${-lean - 2} -2 ${w + lean + 4} ${h + 4}" role="img" aria-label="${label}">`
    + `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-40" y="-10" width="720" height="130">`
    + '<rect x="-40" y="-10" width="720" height="130" fill="#fff"/><rect x="-40" y="61" width="720" height="5" fill="#000"/>'
    + `</mask></defs><g transform="skewX(-12)" mask="url(#${id})">`
    + setWord('OPEN', 0, 'or-logo__open') + setWord('ROAD', 324, 'or-logo__road')
    + '</g></svg>';
}
