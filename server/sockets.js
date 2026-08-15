// Real-time layer: everything that happens after a guest has already joined
// a session (adding tracks, voting, host controls) flows through here.
// Searching Spotify and the initial join handshake go over plain HTTP
// (routes/api.js) since they're simple request/response - only things that
// need to push updates to everyone in the car go over sockets.
import {
  getSession,
  upsertGuest,
  connectedGuestCount,
  makeQueueItem,
  addToSkippedSongs,
  removeFromSkippedSongs,
  endSession,
} from './sessionStore.js';
import { nextRoundForGuest, applyVote } from './queueFairness.js';
import { broadcastState, roomName } from './broadcast.js';
import { startPlaybackLoop, stopPlaybackLoop, skipCurrentTrack } from './playbackEngine.js';
import { pausePlayback, resumePlayback } from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('join', async ({ sessionId, guestId, name, isHost }, ack) => {
      const session = getSession(sessionId);
      if (!session) return ack?.({ error: 'This trip has ended or the code is wrong.' });

      const guest = upsertGuest(session, guestId, name);
      socket.data.sessionId = sessionId;
      socket.data.guestId = guest.id;
      // Trusted client-side flag, not real auth: the only person who ever
      // gets a link with `isHost` in it is whoever just came back from the
      // Spotify login redirect. For a car full of friends, that's enough -
      // this isn't guarding against anything more adversarial than someone
      // fibbing to skip a song, which the group can just re-add anyway.
      socket.data.isHost = Boolean(isHost);
      socket.join(roomName(sessionId));

      startPlaybackLoop(session, io); // no-op if it's already running

      ack?.({ ok: true, guestId: guest.id, guestName: guest.name });
      await broadcastState(io, session);
    });

    socket.on('queue:add', async ({ track }, ack) => {
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const guest = session.guests.get(socket.data.guestId);
      if (!guest) return ack?.({ error: 'Rejoin the session and try again.' });

      const alreadyQueued =
        session.nowPlaying?.uri === track.uri || session.queue.some((item) => item.uri === track.uri);
      if (alreadyQueued) return ack?.({ error: 'That song is already in the queue.' });

      const round = nextRoundForGuest(guest);
      const item = makeQueueItem({ track, guest, round });
      session.queue.push(item);
      removeFromSkippedSongs(session, track.uri); // re-adding a skipped song takes it off that list

      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    socket.on('queue:vote', async ({ itemId, direction }, ack) => {
      if (direction !== 'up' && direction !== 'down') {
        return ack?.({ error: 'Vote must be up or down.' });
      }
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const guestId = socket.data.guestId;
      const guestCount = connectedGuestCount(session);

      const target =
        session.nowPlaying?.id === itemId
          ? { item: session.nowPlaying, isNowPlaying: true }
          : { item: session.queue.find((q) => q.id === itemId), isNowPlaying: false };

      if (!target.item) return ack?.({ error: 'That track is no longer in the queue.' });

      const result = applyVote(target.item, guestId, direction, guestCount);

      if (result.rejected) return ack?.({ error: result.reason });

      ack?.({ ok: true });

      if (result.shouldRemove && target.isNowPlaying) {
        await skipCurrentTrack(session, io, { votedOut: true }); // broadcasts state itself once the next track starts
      } else if (result.shouldRemove) {
        session.queue = session.queue.filter((q) => q.id !== itemId);
        addToSkippedSongs(session, target.item);
        await broadcastState(io, session);
      } else {
        await broadcastState(io, session);
      }
    });

    // --- Host-only playback overrides ------------------------------------
    // The driver should always be able to skip or pause regardless of what
    // the vote threshold says - the group's vote is a way for everyone
    // *else* to weigh in, not a way to lock the driver out of their own
    // stereo.

    socket.on('playback:skip', async (_payload, ack) => {
      const session = requireHost(socket, ack);
      if (!session) return;
      try {
        await skipCurrentTrack(session, io);
        ack?.({ ok: true });
      } catch (err) {
        console.error('[sockets] playback:skip failed:', err.message);
        ack?.({ error: 'Could not skip. Try again in a moment.' });
      }
    });

    socket.on('playback:pause', async (_payload, ack) => {
      const session = requireHost(socket, ack);
      if (!session) return;
      try {
        const accessToken = await ensureFreshToken(session);
        await pausePlayback(accessToken);
        // Set optimistically rather than waiting for the next poll tick
        // (up to 4s away) to pick it up - the command already succeeded,
        // so there's no reason the button state should lag behind it.
        session.isPlaying = false;
        ack?.({ ok: true });
        await broadcastState(io, session);
      } catch (err) {
        console.error('[sockets] playback:pause failed:', err.message);
        ack?.({ error: 'Could not pause. Is Spotify open on the host phone?' });
      }
    });

    socket.on('playback:resume', async (_payload, ack) => {
      const session = requireHost(socket, ack);
      if (!session) return;
      try {
        const accessToken = await ensureFreshToken(session);
        await resumePlayback(accessToken);
        session.isPlaying = true;
        ack?.({ ok: true });
        await broadcastState(io, session);
      } catch (err) {
        console.error('[sockets] playback:resume failed:', err.message);
        ack?.({ error: 'Could not resume. Is Spotify open on the host phone?' });
      }
    });

    socket.on('session:end', async (_payload, ack) => {
      const session = requireHost(socket, ack);
      if (!session) return;

      io.in(roomName(session.id)).emit('session:ended');
      stopPlaybackLoop(session.id);
      endSession(session.id);
      ack?.({ ok: true });
    });

    socket.on('disconnect', async () => {
      const session = getSession(socket.data.sessionId);
      if (!session) return;
      const guest = session.guests.get(socket.data.guestId);
      if (guest) guest.connected = false;
      await broadcastState(io, session);
    });
  });
}

/** Looks up the caller's session and confirms they're the host, acking an error and returning null if not. */
function requireHost(socket, ack) {
  const session = getSession(socket.data.sessionId);
  if (!session) {
    ack?.({ error: 'Session not found.' });
    return null;
  }
  if (!socket.data.isHost) {
    ack?.({ error: 'Only the host can do that.' });
    return null;
  }
  return session;
}
