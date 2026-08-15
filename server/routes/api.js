// Plain HTTP endpoints for the two things that don't need a live socket:
// looking up a session (host's "here's how to join" screen, and a guest
// resolving a room code before they connect) and searching Spotify. Voting
// and adding to the queue happen over sockets.js instead, since those need
// to push updates to everyone else in the car.
import { Router } from 'express';
import QRCode from 'qrcode';
import { getSession, getSessionByRoomCode, connectedGuestCount } from '../sessionStore.js';
import { ensureFreshToken } from '../spotifyAuth.js';
import { searchTracks } from '../spotifyApi.js';
import { config } from '../config.js';

export const apiRouter = Router();

apiRouter.get('/sessions/:id', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const joinUrl = `${config.publicBaseUrl}/guest.html?code=${session.roomCode}`;
  const qrCodeDataUrl = await QRCode.toDataURL(joinUrl);

  res.json({
    sessionId: session.id,
    roomCode: session.roomCode,
    hostDisplayName: session.host.displayName,
    joinUrl,
    qrCodeDataUrl,
    connectedGuestCount: connectedGuestCount(session),
  });
});

apiRouter.get('/sessions/by-code/:roomCode', (req, res) => {
  const session = getSessionByRoomCode(req.params.roomCode);
  if (!session) return res.status(404).json({ error: 'No session found with that code.' });
  res.json({ sessionId: session.id, roomCode: session.roomCode, hostDisplayName: session.host.displayName });
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
