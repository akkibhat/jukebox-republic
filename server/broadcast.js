// Sends the current state of a session (now playing + fairly-ordered queue)
// to everyone connected to its room. Pulled out into its own module so both
// sockets.js (reacting to guest actions) and playbackEngine.js (reacting to
// the clock) can push updates without importing each other.
import { serializeItem, connectedGuestCount } from './sessionStore.js';
import { sortQueue } from './queueFairness.js';

export function roomName(sessionId) {
  return `session:${sessionId}`;
}

/**
 * Broadcasts to everyone in the room, but personalizes `myVote` per socket
 * so each guest's UI can highlight the vote button they've already pressed.
 * Socket.io doesn't support per-recipient payloads on a room broadcast, so
 * we iterate the sockets in the room individually - session queues are tiny
 * (a handful of guests, a handful of tracks), so this is cheap.
 */
export async function broadcastState(io, session) {
  const orderedQueue = sortQueue(session.queue);
  const sockets = await io.in(roomName(session.id)).fetchSockets();

  for (const socket of sockets) {
    const guestId = socket.data.guestId;
    socket.emit('state', {
      roomCode: session.roomCode,
      nowPlaying: serializeItem(session.nowPlaying, guestId),
      queue: orderedQueue.map((item) => serializeItem(item, guestId)),
      connectedGuestCount: connectedGuestCount(session),
    });
  }
}
