// In-memory state for every active session. A "session" is one host's
// playback session: one host Spotify account driving playback, a room code
// guests join with, and the shared queue. Nothing outside this file knows
// or cares how sessions are stored - persistence.js mirrors them to
// Firestore behind that same interface, so this module could be swapped
// for a different backing store without touching a caller.

import { randomUUID } from 'node:crypto';
import { deletePersisted } from './persistence.js';
import { config } from './config.js';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - easy to read aloud

/** Random join code, from an alphabet with no lookalike characters (see ROOM_CODE_CHARS). */
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

/** Creates a session with a unique room code. Called once, right after the host's Spotify login. */
export function createSession({ hostSpotifyId, hostDisplayName, tokens }) {
  const id = randomUUID();
  let roomCode = generateRoomCode();
  while (roomCodeIndex.has(roomCode)) roomCode = generateRoomCode(); // vanishingly unlikely, but be sure

  const session = {
    id,
    roomCode,
    // Fixed for the session's whole life (just roomCode + the configured
    // base URL) - computed once here rather than rebuilt on every
    // GET /api/sessions/:id, which used to also regenerate the QR code PNG
    // (see routes/auth.js for that part) from this same deterministic
    // string on every single request.
    joinUrl: `${config.publicBaseUrl}/guest.html?code=${roomCode}`,
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
    queueMode: 'fair', // 'fair' (round-robin by contributor) or 'crowd' (most votes first) - the host can switch mid-session, see queue:mode in sockets.js
    supportsVolume: null, // whether the current device accepts remote volume changes - null until the first poll reports it, see playbackEngine.js
    bannedGuestIds: new Set(), // guests the host kicked - their join attempts are rejected. Soft moderation: clearing localStorage mints a new id, which is fine for a car/party full of friends
    coHostIds: new Set(), // guests the host promoted - they get the host's playback/kick/end powers, but playback stays on the host's Spotify account
  };

  sessions.set(id, session);
  roomCodeIndex.set(roomCode, id);
  return session;
}

/** Looks up a session by its internal id, or undefined if it's over. */
export function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Finds a still-live session already hosted by this Spotify account, if
 * any - used at login (routes/auth.js) so logging in again (a browser
 * crash, or being told to re-auth after a scope change) resumes the
 * existing party instead of silently spinning up a second, parallel one
 * that leaves already-connected guests talking to an orphaned session.
 * A linear scan is fine here: this runs once per login, not a hot path,
 * and concurrent sessions on this app number in the single digits.
 */
export function getSessionByHostId(hostSpotifyId) {
  for (const session of sessions.values()) {
    if (session.host.spotifyId === hostSpotifyId) return session;
  }
  return undefined;
}

/** Looks up a session by the short code guests type in. Case-insensitive. */
export function getSessionByRoomCode(roomCode) {
  const id = roomCodeIndex.get(roomCode.toUpperCase());
  return id ? sessions.get(id) : undefined;
}

/** Ends a session for good: drops it from memory, frees its room code, and deletes its saved copy. */
export function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  roomCodeIndex.delete(session.roomCode);
  sessions.delete(sessionId);
  deletePersisted(sessionId); // an ended session must not resurrect on the next boot
}

/**
 * Puts a session restored from Firestore back into the in-memory store at
 * boot. Playback loops are NOT restarted here - they come back lazily as
 * each client's socket reconnects and re-joins (socket.io re-emits 'join'
 * on every reconnect, and startPlaybackLoop is a no-op when already
 * running), so a restored session nobody returns to just sits idle.
 */
export function restoreSessionIntoStore(session) {
  sessions.set(session.id, session);
  roomCodeIndex.set(session.roomCode, session.id);
}

/**
 * Adds a guest, or marks a returning one connected again. Reconnecting
 * keeps their submissionCount, so a dropped connection doesn't reset
 * someone's place in the fair rotation.
 */
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

/** How many guests are connected right now - drives the downvote threshold. */
export function connectedGuestCount(session) {
  let count = 0;
  for (const guest of session.guests.values()) {
    if (guest.connected) count += 1;
  }
  return count;
}

/**
 * Everyone currently connected, for the "who's here" chip row - with ids
 * (so the host's kick/promote buttons know who to target) and each one's
 * co-host status (so the badge renders on every phone, not just the
 * host's).
 */
export function connectedGuests(session) {
  const guests = [];
  for (const guest of session.guests.values()) {
    if (guest.connected) {
      guests.push({ id: guest.id, name: guest.name, isCoHost: session.coHostIds.has(guest.id) });
    }
  }
  return guests;
}

/**
 * The handful of fields every track-shaped object in this file copies
 * straight from a raw Spotify track - queue items and both synthetic
 * now-playing sources all start here, which is what keeps their shape
 * consistent without three separate field lists to keep in sync.
 */
function trackFields(track) {
  return {
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    albumArt: track.albumArt,
    durationMs: track.durationMs,
    explicit: Boolean(track.explicit),
  };
}

/** Wraps a Spotify track as a queue entry, tagged with who added it and their rotation round. */
export function makeQueueItem({ track, guest, round, duplicateReason = null }) {
  return {
    id: randomUUID(),
    ...trackFields(track),
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
 * A track Jukebox Republic picked or adopted rather than a guest choosing
 * it - either cycling in an Autopilot Mix pick, or adopting whatever's
 * already playing directly on Spotify (most likely the host taking manual
 * control during a dead zone). Shaped exactly like a normal queue item so
 * it can be voted on, skipped, and land in history the same way anything
 * else does, and so the "is it about to finish" progress check in
 * playbackEngine.js applies to it unchanged. `addedBy` is one of the
 * synthetic contributors (see syntheticContributors.js), which can never
 * match a real guestId, so the self-downvote guard never accidentally
 * blocks the room from downvoting it.
 */
export function makeSyntheticNowPlaying(track, addedBy) {
  return {
    id: randomUUID(),
    ...trackFields(track),
    addedBy,
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
    ...copyTrackFields(item),
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

// Capped because a whole session is persisted as a single Firestore
// document, and those have a hard 1 MiB ceiling - three max-size playlists
// measure ~1.5 MiB and would make every save fail. Still far more music
// than one session can play: at ~3.5 min a track it's over a day of it.
const FALLBACK_POOL_LIMIT = 600;

/**
 * Merges freshly-fetched tracks into the Autopilot Mix, skipping uris
 * already pooled - the same song often appears on more than one seed
 * playlist, and there's no reason to offer it twice.
 */
export function addToFallbackTracks(session, tracks) {
  const existingUris = new Set(session.fallbackTracks.map((t) => t.uri));
  for (const track of tracks) {
    if (session.fallbackTracks.length >= FALLBACK_POOL_LIMIT) break;
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
  session.playHistory.unshift({
    id: item.id,
    ...copyTrackFields(item),
    addedBy: item.addedBy,
    netVotes: item.netVotes ?? 0,
    downvotes: countDownvotes(item.votes),
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

  return {
    id: item.id,
    ...copyTrackFields(item),
    addedBy: item.addedBy,
    round: item.round,
    netVotes: item.netVotes,
    downvotes: countDownvotes(item.votes),
    threshold: threshold ?? null,
    myVote: forGuestId ? item.votes.get(forGuestId) || null : null,
    duplicateReason: item.duplicateReason ?? null,
  };
}

/** Same field set as trackFields, but copying from an already-normalized item rather than a raw Spotify track. */
function copyTrackFields(item) {
  return {
    uri: item.uri,
    name: item.name,
    artist: item.artist,
    albumArt: item.albumArt,
    durationMs: item.durationMs,
    explicit: item.explicit,
  };
}

/** How many of a track's votes are downvotes - shared by history entries and the wire-format serializer. */
function countDownvotes(votes) {
  let downvotes = 0;
  for (const vote of votes?.values() ?? []) {
    if (vote === 'down') downvotes += 1;
  }
  return downvotes;
}
