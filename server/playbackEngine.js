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
import { addToSkippedSongs, addToPlayHistory, makeFallbackNowPlaying, makeExternalNowPlaying } from './sessionStore.js';
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
    // idle, kick off the first track in the fair queue (or a backup pick).
    await tryStartNext(session, io);
    return;
  }

  if (!state) return; // host's device went away (asleep, disconnected) - just wait for it to come back

  if (state.track.uri !== session.nowPlaying.uri) {
    // Something's playing that cartunes didn't pick - most likely the host
    // took manual control (e.g. during a dead zone) rather than a glitch.
    // Rather than yanking it away mid-song, adopt it as the thing we're
    // watching. It's still fully votable, and the very next poll tick's
    // "is it about to finish" check below will reclaim the queue the
    // moment THIS track ends instead of interrupting it.
    session.nowPlaying = makeExternalNowPlaying(state.track);
    await broadcastState(io, session);
    return;
  }

  const trackFinishing = state.progressMs + END_OF_TRACK_LEAD_MS >= session.nowPlaying.durationMs;
  if (trackFinishing) {
    await advanceToNext(session, io);
  }
}

/**
 * Picks what plays next: the fairly-ordered queue if it has anything,
 * otherwise a cycling pick from the host's backup playlist if one's been
 * set. Returns whether it actually got something going, so callers (and
 * the poll loop) know whether to keep waiting or move on.
 */
async function tryStartNext(session, io) {
  const [next, ...rest] = sortQueue(session.queue);
  const usingFallback = !next;
  const fallbackTrack = usingFallback ? nextFallbackTrack(session) : null;
  const trackToPlay = next || fallbackTrack;

  if (!trackToPlay) return false;

  const accessToken = await ensureFreshToken(session);
  const deviceId = await resolveTargetDevice(accessToken);

  if (!deviceId) {
    // Spotify can't see any device at all - nothing we can do until the
    // host opens the Spotify app on their phone. It doesn't need to be
    // playing anything, just open, so it registers as a Connect device.
    // We'll retry automatically on the next poll tick.
    session.playbackBlockedReason = "No Spotify device found. Open Spotify on the host's phone.";
    await broadcastState(io, session);
    return false;
  }

  try {
    await playTrack(accessToken, trackToPlay.uri, deviceId);
  } catch (err) {
    // Spotify refused to start this particular track (region lock, a
    // restriction on the device, a transient API error...). Previously
    // this would just throw, get swallowed by the poll loop's catch, and
    // leave the same broken track stuck at the front of the queue forever
    // - every 4s poll would retry it and fail the same way. Instead, drop
    // it (or move the backup playlist's cursor past it) and let the very
    // next poll tick try whatever comes after it.
    console.error(`[playback] session ${session.roomCode} could not start "${trackToPlay.name}":`, err.message);
    session.playbackBlockedReason = `Spotify wouldn't start "${trackToPlay.name}" - trying the next song.`;
    if (usingFallback) {
      advanceFallbackIndex(session);
    } else {
      session.queue = rest;
    }
    await broadcastState(io, session);
    return false;
  }

  session.playbackBlockedReason = null;
  session.nowPlaying = usingFallback ? makeFallbackNowPlaying(trackToPlay) : trackToPlay;
  session.queue = rest;
  if (usingFallback) advanceFallbackIndex(session);
  await broadcastState(io, session);
  return true;
}

/** The backup playlist cycles in order (not randomly) so it's predictable, looping back to the start once it runs through. */
function nextFallbackTrack(session) {
  if (session.fallbackTracks.length === 0) return null;
  return session.fallbackTracks[session.fallbackIndex % session.fallbackTracks.length];
}

function advanceFallbackIndex(session) {
  if (session.fallbackTracks.length === 0) return;
  session.fallbackIndex = (session.fallbackIndex + 1) % session.fallbackTracks.length;
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
 * Moves the current track out and starts whatever's fairly next. Every
 * track that was ever nowPlaying gets logged to play history regardless of
 * why it's leaving. `votedOut` additionally sends it to the skipped list
 * (only when the group downvoted it past the threshold) so it can be
 * brought back later - a track that simply finished playing, or that the
 * host manually skipped/changed, wasn't rejected by anyone.
 */
export async function advanceToNext(session, io, { votedOut = false } = {}) {
  if (session.nowPlaying) {
    addToPlayHistory(session, session.nowPlaying);
    if (votedOut) {
      addToSkippedSongs(session, session.nowPlaying);
    }
  }
  session.nowPlaying = null;
  await tryStartNext(session, io);
  if (!session.nowPlaying) {
    await broadcastState(io, session); // queue (and any backup playlist) ran dry - let clients know nothing's playing
  }
}

/** Called for both a vote-triggered skip (pass { votedOut: true }) and a host's manual skip. */
export async function skipCurrentTrack(session, io, opts) {
  await advanceToNext(session, io, opts);
}
