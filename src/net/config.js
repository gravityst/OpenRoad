/**
 * The one line to change when the room moves.
 *
 * Public pages MUST use wss://. The game is served over HTTPS, so a ws://
 * endpoint is blocked as mixed content with no user-facing override — it fails
 * silently and looks exactly like a dead server.
 *
 * A dev override is read from localStorage ONLY, never a query parameter: a
 * ?server= link would let anyone point another player's client at a relay that
 * then receives their name and live position. localStorage cannot be set by a link.
 *
 * A page served from this machine (localhost, 127.0.0.1, [::1], or opened as a
 * file) drives ALONE unless that override is set. It used to fall through to
 * the live room, so every harness and every preview tab on a developer's
 * machine joined the kids' public room as a "Driver-NNNN" car steered by test
 * automation. To play against a local server set localStorage
 * 'openroad.server' to 'ws://127.0.0.1:8790' (wrangler dev); to join the live
 * room from localhost on purpose, set it to DEFAULT_ROOM_URL.
 */
export const DEFAULT_ROOM_URL = 'wss://openroad-room.cwaldner.workers.dev';

/** True when the page is served from this machine rather than the public site. */
export function isLocalPage(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc) return false;
  if (loc.protocol === 'file:') return true;
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname || '');
}

export function roomUrl(loc) {
  let override = null;
  try { override = localStorage.getItem('openroad.server'); } catch { /* private mode */ }
  const local = isLocalPage(loc);
  const url = override || (local ? '' : DEFAULT_ROOM_URL);
  if (!url) return '';

  if (/^wss:\/\//i.test(url)) return url;

  // ws:// is allowed ONLY when the page itself is on localhost. A local page is
  // already a secure context, so there is no mixed content to block, and
  // refusing it outright made it impossible to run the server on your own
  // machine while working on the netcode.
  if (/^ws:\/\//i.test(url) && local) return url;

  console.warn('[open road] room URL must be wss:// —', url);
  return '';
}
