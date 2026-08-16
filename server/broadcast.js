// Pushes session state to everyone in a room. Its own module so both
// sockets.js (reacting to guest actions) and playbackEngine.js (reacting to
// the clock) can broadcast without importing each other.
import { serializeItem, connectedGuestCount, connectedGuests } from './sessionStore.js';
import { sortQueue, downvoteThreshold } from './queueFairness.js';
import { schedulePersist } from './persistence.js';

/** Socket.io room name for a session. */
export function roomName(sessionId) {
  return `session:${sessionId}`;
}

/**
 * Sends the current state to every connected socket in the session.
 *
 * Two things vary per recipient - which vote they cast, and whether they
 * hold host powers - so each socket gets its own payload. Everything else
 * is serialized once up front and shared by reference, since recounting
 * votes per socket would repeat identical work for every phone in the room.
 *
 * Pass `persist: false` for cosmetic broadcasts (the periodic progress
 * re-anchor) so they don't each cost a Firestore write - nothing worth
 * saving has changed, and playback position is re-read from Spotify on
 * restore anyway.
 */
export async function broadcastState(io, session, { persist = true } = {}) {
  const guestCount = connectedGuestCount(session);
  // Recomputed per broadcast, not per vote: the threshold moves as people
  // join and leave, so "X of Y to skip" should reflect who's here now.
  const threshold = downvoteThreshold(guestCount);

  const shared = {
    roomCode: session.roomCode,
    skippedSongs: session.skippedSongs,
    playHistory: session.playHistory,
    fallbackTracks: session.fallbackTracks,
    connectedGuestCount: guestCount,
    guests: connectedGuests(session),
    playbackBlockedReason: session.playbackBlockedReason,
    isPlaying: session.isPlaying,
    progressMs: session.progressMs,
    queueMode: session.queueMode,
  };

  // Serialized once, then personalized per socket below. Each entry keeps a
  // reference to the raw item so myVote can be looked up without redoing
  // the vote tally.
  const queue = sortQueue(session.queue, session.queueMode).map((item) => ({
    raw: item,
    payload: serializeItem(item, null, { threshold }),
  }));
  const nowPlaying = session.nowPlaying
    ? { raw: session.nowPlaying, payload: serializeItem(session.nowPlaying, null, { threshold }) }
    : null;

  const sockets = await io.in(roomName(session.id)).fetchSockets();

  for (const socket of sockets) {
    const guestId = socket.data.guestId;
    socket.emit('state', {
      ...shared,
      nowPlaying: nowPlaying && { ...nowPlaying.payload, myVote: voteOf(nowPlaying.raw, guestId) },
      queue: queue.map(({ raw, payload }) => ({ ...payload, myVote: voteOf(raw, guestId) })),
      // Decides whether the host controls render. The server re-checks
      // every action regardless - this is only an affordance.
      youHavePowers: socket.data.isHost || session.coHostIds.has(guestId),
    });
  }

  // Every meaningful state change flows through here, making this the one
  // place that needs to mirror the session to Firestore.
  if (persist) schedulePersist(session);
}

/** This guest's vote on a track, or null if they haven't voted. */
function voteOf(item, guestId) {
  return guestId ? item.votes.get(guestId) || null : null;
}
