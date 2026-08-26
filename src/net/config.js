/**
 * The one line to change when the room moves.
 *
 * MUST be wss://. The game is served over HTTPS from a static host, so a ws://
 * endpoint is blocked as mixed content with no user-facing override — it fails
 * silently and looks exactly like a dead server.
 *
 * A dev override is read from localStorage ONLY, never a query parameter: a
 * ?server= link would let anyone point another player's client at a relay that
 * then receives their name and live position. localStorage cannot be set by a link.
 */
export const DEFAULT_ROOM_URL = '';   // e.g. 'wss://openroad-room.<sub>.workers.dev'

export function roomUrl() {
  let override = null;
  try { override = localStorage.getItem('openroad.server'); } catch { /* private mode */ }
  const url = override || DEFAULT_ROOM_URL;
  if (!url) return '';
  if (!/^wss:\/\//i.test(url)) {
    console.warn('[open road] room URL must be wss:// —', url);
    return '';
  }
  return url;
}
