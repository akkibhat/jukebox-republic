// Firestore-backed session survival. Sessions normally live only in memory
// (sessionStore.js) and die with the process; this module mirrors them into
// Firestore so a server restart or redeploy doesn't end everyone's night.
//
// Design notes:
// - Writes are EVENT-DRIVEN, not periodic: broadcastState() is the single
//   choke point every state change flows through, and it calls
//   schedulePersist() after each broadcast. A per-session 2s debounce
//   collapses bursts (a flurry of votes, the 4s poll ticks) into one write.
//   A quiet session writes nothing at all - well inside Firestore's free
//   tier (~20k writes/day) even for a long, busy party.
// - Reads happen exactly once, at boot (restoreSessions), to rebuild the
//   in-memory store. Playback loops restart lazily as clients reconnect
//   and re-join (socket.io re-emits 'join' on every reconnect).
// - Everything is optional: without Firestore credentials configured, every
//   function is a cheap no-op and the app behaves exactly as before
//   (in-memory only). That keeps local dev zero-setup.
//
// Enabling it needs a Firebase/GCP project with Firestore and either:
//   GOOGLE_APPLICATION_CREDENTIALS=path\to\service-account.json  (and/or)
//   FIRESTORE_PROJECT_ID=your-project-id
// in the environment (see .env.example).

import { Firestore } from '@google-cloud/firestore';

const COLLECTION = 'sessions';
const WRITE_DEBOUNCE_MS = 2000;

/** sessionId -> pending setTimeout handle for a debounced write. */
const pendingWrites = new Map();

/** Lazily-created Firestore client; null until first use, false if disabled. */
let db = null;

/**
 * Persistence is on only when credentials are configured. Resolved lazily
 * (first call) rather than at import time so module evaluation order
 * relative to dotenv doesn't matter. Exported so other modules needing
 * Firestore (seedPlaylistCache.js) share this one client/config instead of
 * each standing up their own.
 */
export function getDb() {
  if (db !== null) return db;

  const configured = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIRESTORE_PROJECT_ID;
  if (!configured) {
    console.log('[persistence] Firestore not configured - sessions are in-memory only and will not survive restarts.');
    db = false;
    return db;
  }

  db = new Firestore({
    projectId: process.env.FIRESTORE_PROJECT_ID || undefined,
    // Sessions legitimately hold nulls, and Firestore rejects undefined -
    // strip any that sneak in rather than failing the whole write.
    ignoreUndefinedProperties: true,
  });
  console.log('[persistence] Firestore persistence enabled.');
  return db;
}

// --- (De)serialization ------------------------------------------------------
// Sessions use Maps and Sets, which neither JSON nor Firestore understand.
// Votes become plain objects (guestId -> 'up'|'down') rather than arrays of
// pairs because Firestore also refuses arrays nested directly inside arrays.

/** Track with a votes Map -> plain object, since Firestore can't store Maps. */
function serializeVotedItem(item) {
  if (!item) return null;
  return { ...item, votes: Object.fromEntries(item.votes ?? []) };
}

/** Inverse of serializeVotedItem - rebuilds the votes Map on the way back in. */
function reviveVotedItem(item) {
  if (!item) return null;
  return { ...item, votes: new Map(Object.entries(item.votes ?? {})) };
}

/** Whole session -> Firestore-safe shape: Maps become arrays/objects, Sets become arrays. */
function serializeSession(session) {
  return {
    ...session,
    guests: [...session.guests.values()],
    queue: session.queue.map(serializeVotedItem),
    nowPlaying: serializeVotedItem(session.nowPlaying),
    bannedGuestIds: [...session.bannedGuestIds],
    coHostIds: [...session.coHostIds],
  };
}

/** Inverse of serializeSession - restores the Maps and Sets the rest of the app expects. */
function reviveSession(data) {
  return {
    ...data,
    guests: new Map(data.guests.map((guest) => [guest.id, guest])),
    queue: (data.queue ?? []).map(reviveVotedItem),
    nowPlaying: reviveVotedItem(data.nowPlaying),
    bannedGuestIds: new Set(data.bannedGuestIds ?? []),
    coHostIds: new Set(data.coHostIds ?? []),
  };
}

// --- Public API -------------------------------------------------------------

/**
 * Queues a (debounced) write of this session's current state. Called after
 * every broadcastState - safe to call as often as state changes.
 */
export function schedulePersist(session) {
  if (!getDb()) return;

  clearTimeout(pendingWrites.get(session.id));
  pendingWrites.set(
    session.id,
    setTimeout(() => {
      pendingWrites.delete(session.id);
      getDb()
        .collection(COLLECTION)
        .doc(session.id)
        .set(serializeSession(session))
        .catch((err) => console.error(`[persistence] failed to save session ${session.roomCode}:`, err.message));
    }, WRITE_DEBOUNCE_MS)
  );
}

/** Removes a session's saved copy once it ends - an ended session should not resurrect on the next boot. */
export function deletePersisted(sessionId) {
  clearTimeout(pendingWrites.get(sessionId));
  pendingWrites.delete(sessionId);
  if (!getDb()) return;

  getDb()
    .collection(COLLECTION)
    .doc(sessionId)
    .delete()
    .catch((err) => console.error(`[persistence] failed to delete session ${sessionId}:`, err.message));
}

/**
 * One-time boot read: every saved session, revived into the in-memory
 * shape. Failure here (bad credentials, network) is downgraded to "start
 * empty" rather than refusing to boot - a music app with amnesia beats no
 * music app at all.
 */
export async function restoreSessions() {
  if (!getDb()) return [];

  try {
    const snapshot = await getDb().collection(COLLECTION).get();
    return snapshot.docs.map((doc) => reviveSession(doc.data()));
  } catch (err) {
    console.error('[persistence] could not restore sessions, starting empty:', err.message);
    return [];
  }
}
