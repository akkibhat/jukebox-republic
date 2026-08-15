// In-memory state for every active session. A "session" is one host's
// playback session: one host Spotify account driving playback, a room code
// guests join with, and the shared queue. No database - sessions are meant
// to live for the length of a drive or a party, and it's fine for them to
// vanish when the server
// restarts. If Jukebox Republic ever needs to survive server restarts or run on
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
    skippedSongs: [], // tracks the group voted out - see addToSkippedSongs below
    playHistory: [], // rolling "recently played" log - see addToPlayHistory below
    fallbackTracks: [], // the Autopilot Mix - seeded once at login from autopilotMix.js; each track is removed once it's used (played or promoted to the queue)
    usedSeedPlaylistIds: [], // hardcoded playlist ids already pulled from this session - set right after seeding (routes/auth.js), grows as playbackEngine.js tops up
    playbackBlockedReason: null, // set by playbackEngine.js when Spotify can't see any device to play on
    isPlaying: null, // true/false once known from Spotify; null until the first poll or host action reports it
    progressMs: null, // how far into the current track playback is, per the last poll - clients interpolate between polls for a smooth progress bar
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

/** Names of everyone currently connected, for the "who's in the car" display. */
export function connectedGuestNames(session) {
  const names = [];
  for (const guest of session.guests.values()) {
    if (guest.connected) names.push(guest.name);
  }
  return names;
}

export function makeQueueItem({ track, guest, round, duplicateReason = null }) {
  return {
    id: randomUUID(),
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    albumArt: track.albumArt,
    durationMs: track.durationMs,
    explicit: Boolean(track.explicit),
    addedBy: { id: guest.id, name: guest.name },
    addedAt: Date.now(),
    round,
    votes: new Map(), // guestId -> 'up' | 'down'
    netVotes: 0,
    playFailures: 0, // bumped by playbackEngine.js on a transient play failure - see pickNextQueueItem
    duplicateReason, // 'queued' | 'playing' | 'played' | null - see detectDuplicate
  };
}

/**
 * Duplicates are allowed in the queue - sometimes a repeat is intentional
 * - but flagged, since sometimes it's added without realizing it's already
 * queued or already played. The reason string doubles as the truthy check
 * (null means "not a duplicate") and lets the UI say *why* rather than
 * just "duplicate". Checked in this order because a track can only match
 * one of these at a time (nowPlaying is never also in session.queue).
 */
export function detectDuplicate(session, uri) {
  if (session.nowPlaying?.uri === uri) return 'playing';
  if (session.queue.some((item) => item.uri === uri)) return 'queued';
  if (session.playHistory.some((item) => item.uri === uri)) return 'played';
  return null;
}

/**
 * A track Jukebox Republic picked from the Autopilot Mix rather than the real
 * queue, shaped exactly like a normal queue item so it can be voted on,
 * skipped, and land in history the same way anything else does. `addedBy`
 * is a synthetic id ('fallback') that can never match a real guestId, so
 * the self-downvote guard never accidentally blocks the room from
 * downvoting it.
 */
export function makeFallbackNowPlaying(track) {
  return {
    id: randomUUID(),
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    albumArt: track.albumArt,
    durationMs: track.durationMs,
    explicit: Boolean(track.explicit),
    addedBy: { id: 'fallback', name: 'Autopilot Mix' },
    addedAt: Date.now(),
    round: 0,
    votes: new Map(),
    netVotes: 0,
  };
}

/**
 * A track Jukebox Republic is watching but didn't choose - someone (almost always
 * the host) started it directly in Spotify, most likely taking manual
 * control during a dead zone. Shaped like any other now-playing item so
 * the existing "is it about to finish" progress check in playbackEngine.js
 * applies to it unchanged, and the group can still vote on it. `addedBy`
 * is a synthetic id, same trick as the Autopilot Mix, so the self-downvote
 * guard can't accidentally match a real guest here either.
 */
export function makeExternalNowPlaying(track) {
  return {
    id: randomUUID(),
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    albumArt: track.albumArt,
    durationMs: track.durationMs,
    explicit: Boolean(track.explicit),
    addedBy: { id: 'external', name: 'Playing on Spotify' },
    addedAt: Date.now(),
    round: 0,
    votes: new Map(),
    netVotes: 0,
  };
}

/**
 * Moves a track the group voted out onto the skipped list instead of just
 * discarding it - a democratic "no" isn't necessarily forever, someone
 * might still want it back later. Votes are stripped since a re-add starts
 * that track's standing with the group fresh.
 */
export function addToSkippedSongs(session, item) {
  session.skippedSongs.unshift({
    id: item.id,
    uri: item.uri,
    name: item.name,
    artist: item.artist,
    albumArt: item.albumArt,
    durationMs: item.durationMs,
    explicit: item.explicit,
    addedBy: item.addedBy,
  });
}

/** Called when a skipped track gets re-added to the queue, so it stops showing up in both places at once. */
export function removeFromSkippedSongs(session, uri) {
  session.skippedSongs = session.skippedSongs.filter((s) => s.uri !== uri);
}

/**
 * Called whenever a track leaves the Autopilot Mix pool for good - promoted
 * into the real queue (by anyone, from the "Add to queue" button or by
 * searching for the same song directly) or played by the autopilot cycle
 * itself. Each track is used at most once per session rather than looping
 * back around.
 */
export function removeFromFallbackTracks(session, uri) {
  session.fallbackTracks = session.fallbackTracks.filter((t) => t.uri !== uri);
}

/**
 * Merges freshly-fetched tracks into the Autopilot Mix, skipping any uri
 * already in the pool. The same song can plausibly turn up on more than
 * one of the hardcoded seed playlists (they're all "road trip" themed),
 * and there's no reason to offer it twice.
 */
export function addToFallbackTracks(session, tracks) {
  const existingUris = new Set(session.fallbackTracks.map((t) => t.uri));
  for (const track of tracks) {
    if (!existingUris.has(track.uri)) {
      session.fallbackTracks.push(track);
      existingUris.add(track.uri);
    }
  }
}

/**
 * A failed play attempt (region lock, a transient API error, a network
 * blip) doesn't necessarily mean the track itself is bad, so unlike a
 * successful play it isn't dropped - just sent to the back of the line to
 * retry later, after everything else has had a turn.
 */
export function moveFallbackTrackToEnd(session, uri) {
  const index = session.fallbackTracks.findIndex((t) => t.uri === uri);
  if (index === -1) return;
  const [track] = session.fallbackTracks.splice(index, 1);
  session.fallbackTracks.push(track);
}

const PLAY_HISTORY_LIMIT = 25;

/**
 * Logs a track once it leaves now-playing, for the "wait, what was that
 * song" moment - regardless of *why* it left (finished normally, host
 * skip, or voted out). That's a deliberate difference from the skipped
 * list: history is a permanent-ish record of what actually played, so a
 * voted-out track re-adding itself doesn't erase that it was here once,
 * and re-adding *from* history doesn't remove the history entry either.
 * Capped so a long session's history doesn't grow without bound.
 *
 * The vote tally is frozen into the entry at this moment - votes only
 * accumulate while a track is queued or playing, so whatever it holds as
 * it leaves now-playing is its final score. That's what the golden-record
 * badge and the end-of-session election results are computed from.
 */
export function addToPlayHistory(session, item, { votedOut = false } = {}) {
  let downvotes = 0;
  for (const vote of item.votes?.values() ?? []) {
    if (vote === 'down') downvotes += 1;
  }

  session.playHistory.unshift({
    id: item.id,
    uri: item.uri,
    name: item.name,
    artist: item.artist,
    albumArt: item.albumArt,
    durationMs: item.durationMs,
    explicit: item.explicit,
    addedBy: item.addedBy,
    netVotes: item.netVotes ?? 0,
    downvotes,
    votedOut, // true only when the group's majority vote removed it - a host skip or natural finish isn't a rejection
    playedAt: Date.now(),
  });
  if (session.playHistory.length > PLAY_HISTORY_LIMIT) {
    session.playHistory.length = PLAY_HISTORY_LIMIT;
  }
}

/**
 * Serializes a queue item (or nowPlaying track) for sending over the socket
 * - Maps don't survive JSON. `threshold` (how many downvotes it takes to
 * sink this track, given who's currently connected) is passed in by the
 * caller rather than computed here, since it depends on connectedGuestCount
 * which this function has no reason to know about on its own.
 */
export function serializeItem(item, forGuestId, { threshold } = {}) {
  if (!item) return null;

  let downvotes = 0;
  for (const vote of item.votes.values()) {
    if (vote === 'down') downvotes += 1;
  }

  return {
    id: item.id,
    uri: item.uri,
    name: item.name,
    artist: item.artist,
    albumArt: item.albumArt,
    durationMs: item.durationMs,
    explicit: item.explicit,
    addedBy: item.addedBy,
    round: item.round,
    netVotes: item.netVotes,
    downvotes,
    threshold: threshold ?? null,
    myVote: forGuestId ? item.votes.get(forGuestId) || null : null,
    duplicateReason: item.duplicateReason ?? null,
  };
}
