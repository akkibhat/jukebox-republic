// Drives what actually plays. cartunes treats our own fairly-ordered queue
// as the source of truth - not Spotify's built-in queue, which can't be
// reordered or have items pulled out of the middle, both of which the
// voting system needs to do. So instead of using Spotify's "add to queue"
// endpoint, this engine explicitly commands "play track X now" each time a
// track needs to start, on a timer that watches the current track's
// progress and advances when it's about to end.
import { getPlaybackState, playTrack } from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';
import { sortQueue } from './queueFairness.js';
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
  const state = await getPlaybackState(accessToken);
  await playTrack(accessToken, next.uri, state?.deviceId);

  session.nowPlaying = next;
  session.queue = rest;
  await broadcastState(io, session);
}

/** Moves the current track out (played through or skipped) and starts whatever's fairly next. */
export async function advanceToNext(session, io) {
  session.nowPlaying = null;
  await tryStartNext(session, io);
  if (!session.nowPlaying) {
    await broadcastState(io, session); // queue ran dry - let clients know nothing's playing
  }
}

/** Called when a downvote pushes the *currently playing* track past the skip threshold. */
export async function skipCurrentTrack(session, io) {
  await advanceToNext(session, io);
}
