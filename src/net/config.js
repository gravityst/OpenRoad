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
 */
export const DEFAULT_ROOM_URL = 'wss://openroad-room.waldnerc34.workers.dev';

export function roomUrl() {
  let override = null;
  try { override = localStorage.getItem('openroad.server'); } catch { /* private mode */ }
  const url = override || DEFAULT_ROOM_URL;
  if (!url) return '';

  if (/^wss:\/\//i.test(url)) return url;

  // ws:// is allowed ONLY when the page itself is on localhost. A local page is
  // already a secure context, so there is no mixed content to block, and
  // refusing it outright made it impossible to run the server on your own
  // machine while working on the netcode.
  const local = typeof location !== 'undefined' &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (/^ws:\/\//i.test(url) && local) return url;

  console.warn('[open road] room URL must be wss:// —', url);
  return '';
}
