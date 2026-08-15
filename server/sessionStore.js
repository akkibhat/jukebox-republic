// In-memory state for every active road trip. A "session" is one car's
// party: one host Spotify account driving playback, a room code guests join
// with, and the shared queue. No database - sessions are meant to live for
// the length of a drive and it's fine for them to vanish when the server
// restarts. If cartunes ever needs to survive server restarts or run on
// multiple instances, this is the module to swap for a Redis-backed one;
// nothing outside this file knows or cares how sessions are stored.

import { randomUUID } from 'node:crypto';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - easy to read aloud

function generateRoomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

/** sessionId -> session object. */
const sessions = new Map();
/** roomCode -> sessionId, so guests can join by typing/scanning a short code. */
const roomCodeIndex = new Map();

export function createSession({ hostSpotifyId, hostDisplayName, tokens }) {
  const id = randomUUID();
  let roomCode = generateRoomCode();
  while (roomCodeIndex.has(roomCode)) roomCode = generateRoomCode(); // vanishingly unlikely, but be sure

  const session = {
    id,
    roomCode,
    createdAt: Date.now(),
    host: { spotifyId: hostSpotifyId, displayName: hostDisplayName },
    tokens, // { accessToken, refreshToken, expiresAt } - see spotifyAuth.js
    guests: new Map(), // guestId -> { id, name, submissionCount, connected }
    queue: [], // array of queue items, see addTrackToQueue below
    nowPlaying: null, // { uri, name, artist, albumArt, durationMs, startedAt, votes, netVotes }
  };

  sessions.set(id, session);
  roomCodeIndex.set(roomCode, id);
  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function getSessionByRoomCode(roomCode) {
  const id = roomCodeIndex.get(roomCode.toUpperCase());
  return id ? sessions.get(id) : undefined;
}

export function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  roomCodeIndex.delete(session.roomCode);
  sessions.delete(sessionId);
}

export function upsertGuest(session, guestId, name) {
  const existing = session.guests.get(guestId);
  if (existing) {
    existing.connected = true;
    if (name) existing.name = name;
    return existing;
  }
  const guest = { id: guestId, name: name || 'Guest', submissionCount: 0, connected: true };
  session.guests.set(guestId, guest);
  return guest;
}

export function connectedGuestCount(session) {
  let count = 0;
  for (const guest of session.guests.values()) {
    if (guest.connected) count += 1;
  }
  return count;
}

export function makeQueueItem({ track, guest, round }) {
  return {
    id: randomUUID(),
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    albumArt: track.albumArt,
    durationMs: track.durationMs,
    addedBy: { id: guest.id, name: guest.name },
    addedAt: Date.now(),
    round,
    votes: new Map(), // guestId -> 'up' | 'down'
    netVotes: 0,
  };
}

/** Serializes a queue item (or nowPlaying track) for sending over the socket - Maps don't survive JSON. */
export function serializeItem(item, forGuestId) {
  if (!item) return null;
  return {
    id: item.id,
    uri: item.uri,
    name: item.name,
    artist: item.artist,
    albumArt: item.albumArt,
    durationMs: item.durationMs,
    addedBy: item.addedBy,
    round: item.round,
    netVotes: item.netVotes,
    myVote: forGuestId ? item.votes.get(forGuestId) || null : null,
  };
}
