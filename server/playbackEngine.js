// Drives what actually plays. cartunes treats our own fairly-ordered queue
// as the source of truth - not Spotify's built-in queue, which can't be
// reordered or have items pulled out of the middle, both of which the
// voting system needs to do. So instead of using Spotify's "add to queue"
// endpoint, this engine explicitly commands "play track X now" each time a
// track needs to start, on a timer that watches the current track's
// progress and advances when it's about to end.
import { getPlaybackState, getAvailableDevices, playTrack } from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';
import { sortQueue } from './queueFairness.js';
import { addToSkippedSongs } from './sessionStore.js';
import { broadcastState } from './broadcast.js';

const POLL_INTERVAL_MS = 4000;
// Advance a little before the track actually ends so there's no dead-air
// gap while we wait for Spotify to confirm the next PUT /play call.
const END_OF_TRACK_LEAD_MS = 2500;

/** sessionId -> setInterval handle, so each session's loop can be stopped independently. */
const loops = new Map();

export function startPlaybackLoop(session, io) {
  if (loops.has(session.id)) return; // already running

  const tick = () => pollAndAdvance(session, io).catch((err) => {
    console.error(`[playback] session ${session.roomCode} poll failed:`, err.message);
  });

  const handle = setInterval(tick, POLL_INTERVAL_MS);
  loops.set(session.id, handle);
}

export function stopPlaybackLoop(sessionId) {
  const handle = loops.get(sessionId);
  if (handle) clearInterval(handle);
  loops.delete(sessionId);
}

async function pollAndAdvance(session, io) {
  const accessToken = await ensureFreshToken(session);
  const state = await getPlaybackState(accessToken);

  // Picked up here so the host controls can show "Playing"/"Paused" and
  // grey out whichever button doesn't apply, even when the host pauses or
  // resumes from their own Spotify app instead of cartunes' buttons. Only
  // broadcasts when it actually changes, so an unremarkable poll tick
  // doesn't re-send state to everyone for no reason.
  const isPlaying = state?.isPlaying ?? null;
  if (session.isPlaying !== isPlaying) {
    session.isPlaying = isPlaying;
    await broadcastState(io, session);
  }

  if (!session.nowPlaying) {
    // Nothing queued up on our side yet - if the host's device is sitting
    // idle, kick off the first track in the fair queue.
    await tryStartNext(session, io);
    return;
  }

  if (!state) return; // host's device went away (asleep, disconnected) - just wait for it to come back

  const trackFinishing = state.progressMs + END_OF_TRACK_LEAD_MS >= session.nowPlaying.durationMs;
  const trackChangedUnderneathUs = state.track.uri !== session.nowPlaying.uri;

  if (trackFinishing || trackChangedUnderneathUs) {
    await advanceToNext(session, io);
  }
}

async function tryStartNext(session, io) {
  const [next, ...rest] = sortQueue(session.queue);
  if (!next) return;

  const accessToken = await ensureFreshToken(session);
  const deviceId = await resolveTargetDevice(accessToken);

  if (!deviceId) {
    // Spotify can't see any device at all - nothing we can do until the
    // host opens the Spotify app on their phone. It doesn't need to be
    // playing anything, just open, so it registers as a Connect device.
    // We'll retry automatically on the next poll tick.
    session.playbackBlockedReason = "No Spotify device found. Open Spotify on the host's phone.";
    await broadcastState(io, session);
    return;
  }

  await playTrack(accessToken, next.uri, deviceId);

  session.playbackBlockedReason = null;
  session.nowPlaying = next;
  session.queue = rest;
  await broadcastState(io, session);
}

/**
 * Picks which Connect device to send playback to. getPlaybackState only
 * reports a device once something is already playing/paused there, which
 * is useless when starting a trip from cold - so this asks Spotify for
 * every device it can currently see instead. Prefers one already marked
 * active, then a phone (the expected case: the driver's phone through
 * Android Auto), then whatever's left rather than refusing to play at all.
 */
async function resolveTargetDevice(accessToken) {
  const devices = await getAvailableDevices(accessToken);
  if (devices.length === 0) return null;
  const active = devices.find((d) => d.isActive);
  const phone = devices.find((d) => d.type === 'Smartphone');
  return (active || phone || devices[0]).id;
}

/**
 * Moves the current track out and starts whatever's fairly next.
 * `votedOut` distinguishes *why* it's leaving: true only when the group
 * downvoted it past the skip threshold, in which case it goes onto the
 * skipped list for anyone to bring back. A track that simply finished
 * playing, or that the host manually skipped/changed, wasn't rejected by
 * anyone - it just leaves normally, no skipped-list entry.
 */
export async function advanceToNext(session, io, { votedOut = false } = {}) {
  if (votedOut && session.nowPlaying) {
    addToSkippedSongs(session, session.nowPlaying);
  }
  session.nowPlaying = null;
  await tryStartNext(session, io);
  if (!session.nowPlaying) {
    await broadcastState(io, session); // queue ran dry - let clients know nothing's playing
  }
}

/** Called for both a vote-triggered skip (pass { votedOut: true }) and a host's manual skip. */
export async function skipCurrentTrack(session, io, opts) {
  await advanceToNext(session, io, opts);
}
