// Real-time layer: everything that happens after a guest has already joined
// a session (adding tracks, voting) flows through here. Searching Spotify
// and the initial join handshake go over plain HTTP (routes/api.js) since
// they're simple request/response - only things that need to push updates
// to everyone in the car go over sockets.
import { getSession, upsertGuest, connectedGuestCount, makeQueueItem } from './sessionStore.js';
import { nextRoundForGuest, applyVote } from './queueFairness.js';
import { broadcastState, roomName } from './broadcast.js';
import { startPlaybackLoop, skipCurrentTrack } from './playbackEngine.js';
import { config } from './config.js';

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('join', async ({ sessionId, guestId, name }, ack) => {
      const session = getSession(sessionId);
      if (!session) return ack?.({ error: 'This trip has ended or the code is wrong.' });

      const guest = upsertGuest(session, guestId, name);
      socket.data.sessionId = sessionId;
      socket.data.guestId = guest.id;
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

      const round = nextRoundForGuest(guest);
      const item = makeQueueItem({ track, guest, round });
      session.queue.push(item);

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

      const { shouldRemove } = applyVote(target.item, guestId, direction, guestCount, config.voteSkipOffset);

      ack?.({ ok: true });

      if (shouldRemove && target.isNowPlaying) {
        await skipCurrentTrack(session, io); // broadcasts state itself once the next track starts
      } else if (shouldRemove) {
        session.queue = session.queue.filter((q) => q.id !== itemId);
        await broadcastState(io, session);
      } else {
        await broadcastState(io, session);
      }
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
