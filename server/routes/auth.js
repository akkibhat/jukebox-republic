// Login is host-only: whoever authenticates here becomes the account that
// controls playback for the whole car. Guests never hit these routes at
// all - they join with a room code instead (see routes/api.js).
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../spotifyAuth.js';
import { getCurrentUserProfile } from '../spotifyApi.js';
import { createSession, addToFallbackTracks, getSessionByHostId } from '../sessionStore.js';
import { pickSeedPlaylist } from '../autopilotMix.js';
import { getSeedPlaylistTracks } from '../seedPlaylistCache.js';
import { schedulePersist } from '../persistence.js';

export const authRouter = Router();

// Short-lived store of "state" values we've handed out, so the callback can
// confirm the redirect actually came from an authorize flow we started
// (basic CSRF protection for OAuth) rather than a forged request.
const pendingStates = new Set();

authRouter.get('/login', (req, res) => {
  const state = randomUUID();
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000); // expire unused states after 10 min

  res.redirect(buildAuthorizeUrl(state));
});

authRouter.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Spotify login failed: ${error}`);
  if (!state || !pendingStates.has(state)) {
    return res.status(400).send('Login request expired or is invalid - please try again from the start.');
  }
  pendingStates.delete(state);

  try {
    const tokens = await exchangeCodeForTokens(code);
    const profile = await getCurrentUserProfile(tokens.accessToken);

    // Logging in again while this account already has a live session -
    // a browser crash, or being told to re-auth after a scope change -
    // resumes that session in place (fresh tokens, same room code, same
    // queue and guests) rather than silently spinning up a second,
    // parallel one that leaves already-connected guests pointed at an
    // orphaned session nobody's looking at.
    const existing = getSessionByHostId(profile.id);
    if (existing) {
      existing.tokens = tokens;
      schedulePersist(existing);
      console.log(`[auth] resumed existing session ${existing.roomCode} for ${profile.displayName} (tokens refreshed)`);
      return res.redirect(`/host.html?session=${existing.id}`);
    }

    const session = createSession({
      hostSpotifyId: profile.id,
      hostDisplayName: profile.displayName,
      tokens,
    });

    // Rendered once here rather than on every "here's how to join" fetch -
    // session.joinUrl is fixed for the session's whole life, so the PNG
    // would come out identical every time anyway. High error correction
    // (tolerates ~30% of the code being obscured) is what lets host.js
    // safely draw the app's logo over the center client-side.
    session.qrCodeDataUrl = await QRCode.toDataURL(session.joinUrl, { errorCorrectionLevel: 'H' });

    // Seeded once, right at session start, rather than on-demand the first
    // time the queue runs dry - that would add a delay right when everyone
    // wants music. Not fatal if it fails (rate limit, a since-deleted
    // playlist) - the session still starts fine, just without an Autopilot
    // Mix ready until someone adds a real song.
    const seedPlaylist = pickSeedPlaylist();
    session.usedSeedPlaylistIds.push(seedPlaylist.id);
    try {
      const tracks = await getSeedPlaylistTracks(tokens.accessToken, seedPlaylist);
      addToFallbackTracks(session, tracks);
      console.log(
        `[auth] seeded Autopilot Mix for ${session.roomCode} from "${seedPlaylist.label}" (${session.fallbackTracks.length} tracks)`
      );
    } catch (err) {
      console.error('[auth] failed to seed Autopilot Mix:', err.message);
    }

    res.redirect(`/host.html?session=${session.id}`);
  } catch (err) {
    console.error('[auth] callback failed:', err);
    res.status(500).send('Something went wrong connecting to Spotify. Check the server logs and try again.');
  }
});
