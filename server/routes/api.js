// Plain HTTP endpoints for the two things that don't need a live socket:
// looking up a session (host's "here's how to join" screen, and a guest
// resolving a room code before they connect) and searching Spotify. Voting
// and adding to the queue happen over sockets.js instead, since those need
// to push updates to everyone else in the car.
import { Router } from 'express';
import { getSession, getSessionByRoomCode, connectedGuestCount } from '../sessionStore.js';
import { ensureFreshToken } from '../spotifyAuth.js';
import { searchTracks, searchPlaylists } from '../spotifyApi.js';

export const apiRouter = Router();

apiRouter.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  // joinUrl and qrCodeDataUrl are computed once at login (routes/auth.js) -
  // both are fixed for the session's whole life, so there's nothing to
  // redo here even though the host may hit this endpoint more than once.
  res.json({
    sessionId: session.id,
    roomCode: session.roomCode,
    hostDisplayName: session.host.displayName,
    joinUrl: session.joinUrl,
    qrCodeDataUrl: session.qrCodeDataUrl,
    connectedGuestCount: connectedGuestCount(session),
  });
});

apiRouter.get('/sessions/by-code/:roomCode', (req, res) => {
  const session = getSessionByRoomCode(req.params.roomCode);
  if (!session) return res.status(404).json({ error: 'No session found with that code.' });
  res.json({ sessionId: session.id, roomCode: session.roomCode, hostDisplayName: session.host.displayName });
});

// Playlist search for the host's Autopilot Mix admin UI. Read-only, so
// it's fine as a plain HTTP route like track search - the *add* itself
// goes over a host-guarded socket event (autopilot:addPlaylist).
apiRouter.get('/sessions/:id/playlist-search', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const query = req.query.q;
  if (!query || !query.trim()) return res.json({ results: [] });

  try {
    const accessToken = await ensureFreshToken(session);
    const results = await searchPlaylists(accessToken, query.trim());
    res.json({ results });
  } catch (err) {
    console.error('[api] playlist search failed:', err);
    res.status(502).json({ error: 'Spotify search failed. Try again in a moment.' });
  }
});

apiRouter.get('/sessions/:id/search', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const query = req.query.q;
  if (!query || !query.trim()) return res.json({ results: [] });

  try {
    const accessToken = await ensureFreshToken(session);
    const results = await searchTracks(accessToken, query.trim());
    res.json({ results });
  } catch (err) {
    console.error('[api] search failed:', err);
    res.status(502).json({ error: 'Spotify search failed. Try again in a moment.' });
  }
});
