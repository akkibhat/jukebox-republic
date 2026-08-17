// Pushes session state to everyone in a room. Its own module so both
// sockets.js (reacting to guest actions) and playbackEngine.js (reacting to
// the clock) can broadcast without importing each other.
import { serializeItem, connectedGuests } from './sessionStore.js';
import { sortQueue, downvoteThreshold } from './queueFairness.js';
import { findGoldenRecord } from './goldenRecord.js';
import { schedulePersist } from './persistence.js';

/** Socket.io room name for a session. */
export function roomName(sessionId) {
  return `session:${sessionId}`;
}

/**
 * Sends the current state to every connected socket in the session, and
 * mirrors it to Firestore. This is the one place a Firestore write can
 * happen, since it's the one place every meaningful state change flows
 * through - for the periodic cosmetic progress tick, where nothing here
 * has actually changed, use broadcastProgress instead.
 *
 * Two things vary per recipient - which vote they cast, and whether they
 * hold host powers - so each socket gets its own payload. Everything else
 * is serialized once up front and shared by reference, since recounting
 * votes per socket would repeat identical work for every phone in the room.
 */
export async function broadcastState(io, session) {
  const guests = connectedGuests(session);
  // Recomputed per broadcast, not per vote: the threshold moves as people
  // join and leave, so "X of Y to skip" should reflect who's here now.
  const threshold = downvoteThreshold(guests.length);

  const shared = {
    roomCode: session.roomCode,
    skippedSongs: session.skippedSongs,
    playHistory: session.playHistory,
    fallbackTracks: session.fallbackTracks,
    connectedGuestCount: guests.length,
    guests,
    // Sent to everyone (cheap - a handful of entries at most) but only
    // rendered client-side for whoever holds host/co-host powers, same
    // pattern as the kick/promote buttons above - the server is the real
    // gate on the unban action itself regardless of what's shown.
    bannedGuests: [...session.bannedGuestIds].map((id) => ({
      id,
      name: session.guests.get(id)?.name || 'Unknown guest',
    })),
    playbackBlockedReason: session.playbackBlockedReason,
    isPlaying: session.isPlaying,
    progressMs: session.progressMs,
    queueMode: session.queueMode,
    supportsVolume: session.supportsVolume,
    // Computed once per broadcast rather than by every client re-scanning
    // playHistory on every render - see goldenRecord.js for the rule.
    goldenRecordId: findGoldenRecord(session.playHistory)?.id ?? null,
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

  schedulePersist(session);
}

/**
 * A lightweight alternative to broadcastState for the periodic progress
 * re-anchor, where only the playback position moved. Sending the full
 * state - re-sorting the queue, re-serializing every track, personalizing
 * per socket - to move a number the client already interpolates locally
 * was pure waste; this sends just the two fields that changed, and never
 * touches Firestore (nothing persistable happens between real state
 * changes, which all still go through broadcastState above).
 */
export async function broadcastProgress(io, session) {
  io.in(roomName(session.id)).emit('progress', {
    progressMs: session.progressMs,
    isPlaying: session.isPlaying,
  });
}

/** This guest's vote on a track, or null if they haven't voted. */
function voteOf(item, guestId) {
  return guestId ? item.votes.get(guestId) || null : null;
}
