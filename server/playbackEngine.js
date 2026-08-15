// Drives what actually plays. cartunes treats our own fairly-ordered queue
// as the source of truth - not Spotify's built-in queue, which can't be
// reordered or have items pulled out of the middle, both of which the
// voting system needs to do. So instead of using Spotify's "add to queue"
// endpoint, this engine explicitly commands "play track X now" each time a
// track needs to start, on a timer that watches the current track's
// progress and advances when it's about to end.
import { getPlaybackState, getAvailableDevices, getPlaylistTracks, playTrack } from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';
import { sortQueue } from './queueFairness.js';
import { otherSeedPlaylist } from './autopilotMix.js';
import {
  addToSkippedSongs,
  addToPlayHistory,
  makeFallbackNowPlaying,
  makeExternalNowPlaying,
  removeFromFallbackTracks,
  moveFallbackTrackToEnd,
} from './sessionStore.js';
import { broadcastState } from './broadcast.js';

const POLL_INTERVAL_MS = 4000;
// Advance a little before the track actually ends so there's no dead-air
// gap while we wait for Spotify to confirm the next PUT /play call.
const END_OF_TRACK_LEAD_MS = 2500;
// A queued track gets this many in-place retries before it's pushed behind
// anything that hasn't failed yet, and this many total attempts before
// cartunes gives up on it entirely - see pickNextQueueItem.
const RETRY_DEMOTION_THRESHOLD = 2;
const MAX_TRANSIENT_FAILURES = 5;

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
 * otherwise a cycling pick from the trip's Autopilot Mix. Returns whether
 * it actually got something going, so callers (and the poll loop) know
 * whether to keep waiting or move on.
 */
async function tryStartNext(session, io) {
  const next = pickNextQueueItem(session.queue);
  const usingFallback = !next;

  const accessToken = await ensureFreshToken(session);

  if (usingFallback && session.fallbackTracks.length === 0) {
    // The chosen seed playlist ran dry - top up from the other hardcoded
    // one before giving up, rather than going silent for the rest of the
    // trip. Needs accessToken, which is why this check happens after
    // fetching it above instead of staying inside nextFallbackTrack().
    await topUpAutopilotMix(session, accessToken);
  }

  const fallbackTrack = usingFallback ? nextFallbackTrack(session) : null;
  const trackToPlay = next || fallbackTrack;

  if (!trackToPlay) return false;

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
    console.error(`[playback] session ${session.roomCode} could not start "${trackToPlay.name}":`, err.message);
    session.playbackBlockedReason = `Spotify wouldn't start "${trackToPlay.name}" - trying the next song.`;

    if (usingFallback) {
      // Autopilot Mix picks always get a second chance, moved to the back
      // of the line rather than dropped - the whole point of the mix is
      // to never need active management, so it should be forgiving.
      moveFallbackTrackToEnd(session, trackToPlay.uri);
    } else if (classifyPlaybackError(err) === 'permanent') {
      // Spotify explicitly rejected this specific track (region lock, a
      // restriction, a removed/invalid uri) - retrying changes nothing,
      // so there's no reason to make whoever added it wait it out.
      session.queue = session.queue.filter((item) => item.id !== trackToPlay.id);
    } else {
      // Transient (network blip, Spotify 5xx, rate limit) - worth
      // retrying. pickNextQueueItem() handles the demotion once
      // playFailures crosses the threshold; this just increments it.
      // Previously any failure here would just throw, get swallowed by
      // the poll loop's catch, and leave the same broken track stuck at
      // the front forever, retried identically every 4s.
      trackToPlay.playFailures += 1;
      if (trackToPlay.playFailures >= MAX_TRANSIENT_FAILURES) {
        session.queue = session.queue.filter((item) => item.id !== trackToPlay.id);
      }
    }

    await broadcastState(io, session);
    return false;
  }

  session.playbackBlockedReason = null;
  session.nowPlaying = usingFallback ? makeFallbackNowPlaying(trackToPlay) : trackToPlay;
  if (!usingFallback) {
    session.queue = session.queue.filter((item) => item.id !== trackToPlay.id);
  }
  // Once a track plays via the Autopilot Mix, it's used - it shouldn't
  // cycle back around later, and it also stops showing up in the "Add to
  // queue" preview list (there'd be nothing left to add, it's playing).
  if (usingFallback) removeFromFallbackTracks(session, trackToPlay.uri);
  await broadcastState(io, session);
  return true;
}

/**
 * Picks the next queue item in fair order, except a track that's already
 * failed to start `RETRY_DEMOTION_THRESHOLD` times gets pushed behind
 * everything that hasn't - one repeatedly-failing song shouldn't stall
 * everyone else's turn. It's still eventually retried, just once nothing
 * fresher is waiting (and it gets dropped outright past
 * MAX_TRANSIENT_FAILURES - see tryStartNext).
 */
function pickNextQueueItem(queue) {
  const ordered = sortQueue(queue);
  const notYetDemoted = ordered.filter((item) => item.playFailures < RETRY_DEMOTION_THRESHOLD);
  const demoted = ordered.filter((item) => item.playFailures >= RETRY_DEMOTION_THRESHOLD);
  return notYetDemoted[0] || demoted[0] || null;
}

/**
 * Sorts a playback failure into "worth retrying" or "won't ever succeed".
 * A raw fetch() failure (no network route to Spotify at all - the request
 * never got a response) never gets a `.status` attached, which doubles as
 * the signal that it's a connectivity problem rather than Spotify
 * rejecting the request. 5xx (Spotify's own servers) and 429 (rate
 * limited) are also not the track's fault. Anything else - 403 restricted,
 * 404 not found, etc. - is Spotify explicitly saying no to this specific
 * track, and no amount of retrying changes that answer.
 */
function classifyPlaybackError(err) {
  if (typeof err.status !== 'number') return 'transient';
  if (err.status === 429 || err.status >= 500) return 'transient';
  return 'permanent';
}

/** Autopilot Mix tracks are taken in order (not randomly) so it's predictable, and each one is used at most once per trip. */
function nextFallbackTrack(session) {
  return session.fallbackTracks[0] || null;
}

/**
 * Pulls in the second hardcoded seed playlist once the first one's fully
 * drained. Only ever attempted once per trip (usedBothSeedPlaylists),
 * whether it succeeds or fails - if it fails, the poll loop would
 * otherwise hit this same failing fetch every 4s for the rest of the trip.
 */
async function topUpAutopilotMix(session, accessToken) {
  if (session.usedBothSeedPlaylists) return;
  session.usedBothSeedPlaylists = true;

  const next = otherSeedPlaylist(session.seedPlaylistId);
  if (!next) return;

  try {
    const tracks = await getPlaylistTracks(accessToken, next.id);
    session.fallbackTracks.push(...tracks);
    console.log(
      `[playback] session ${session.roomCode} topped up Autopilot Mix from "${next.label}" (${tracks.length} tracks)`
    );
  } catch (err) {
    console.error(`[playback] session ${session.roomCode} failed to top up Autopilot Mix:`, err.message);
  }
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
    await broadcastState(io, session); // queue (and the Autopilot Mix) ran dry - let clients know nothing's playing
  }
}

/** Called for both a vote-triggered skip (pass { votedOut: true }) and a host's manual skip. */
export async function skipCurrentTrack(session, io, opts) {
  await advanceToNext(session, io, opts);
}
