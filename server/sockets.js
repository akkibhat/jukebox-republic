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
  detectDuplicate,
  addToSkippedSongs,
  removeFromSkippedSongs,
  removeFromFallbackTracks,
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

      // Duplicates are allowed now, not rejected - sometimes a repeat is
      // intentional, sometimes it's added without realizing it's already
      // queued or already played. Either way it's flagged (see
      // detectDuplicate) rather than blocked, and anyone can pull it back
      // out below, not just whoever added it.
      const duplicateReason = detectDuplicate(session, track.uri);

      const round = nextRoundForGuest(guest);
      const item = makeQueueItem({ track, guest, round, duplicateReason });
      session.queue.push(item);
      removeFromSkippedSongs(session, track.uri); // re-adding a skipped song takes it off that list
      removeFromFallbackTracks(session, track.uri); // promoted to the real queue - out of the Autopilot Mix pool

      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    // A guest can pull their own submission back out any time before it
    // plays, no group vote needed - that's just changing your mind, not a
    // democratic rejection, so it doesn't touch the skipped list either.
    // A flagged duplicate is the one exception to "only the adder can
    // remove it" - it was often added without realizing it's a repeat, so
    // anyone in the car can clear it rather than waiting on the adder to
    // notice.
    socket.on('queue:remove', async ({ itemId }, ack) => {
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const item = session.queue.find((q) => q.id === itemId);
      if (!item) return ack?.({ error: 'That track is no longer in the queue.' });
      if (item.addedBy.id !== socket.data.guestId && !item.duplicateReason) {
        return ack?.({ error: 'You can only remove songs you added.' });
      }

      session.queue = session.queue.filter((q) => q.id !== itemId);
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

      try {
        const accessToken = await ensureFreshToken(session);
        await pausePlayback(accessToken);
      } catch (err) {
        // Not fatal - the trip ends either way. This is just a courtesy so
        // the car doesn't keep playing after everyone's done with cartunes;
        // if the host's phone is already asleep or offline, there's no
        // device to pause anyway.
        console.error(`[sockets] session:end could not pause playback for ${session.roomCode}:`, err.message);
      }

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
