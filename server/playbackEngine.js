// Drives what actually plays. Jukebox Republic treats our own fairly-ordered queue
// as the source of truth - not Spotify's built-in queue, which can't be
// reordered or have items pulled out of the middle, both of which the
// voting system needs to do. So instead of using Spotify's "add to queue"
// endpoint, this engine explicitly commands "play track X now" each time a
// track needs to start, on a timer that watches the current track's
// progress and advances when it's about to end.
import { getPlaybackState, getAvailableDevices, getPlaylistTracks, playTrack } from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';
import { sortQueue } from './queueFairness.js';
import { nextUnusedSeedPlaylist } from './autopilotMix.js';
import {
  addToSkippedSongs,
  addToPlayHistory,
  makeSyntheticNowPlaying,
  removeFromFallbackTracks,
  moveFallbackTrackToEnd,
  addToFallbackTracks,
  connectedGuestCount,
} from './sessionStore.js';
import { FALLBACK_CONTRIBUTOR, EXTERNAL_CONTRIBUTOR } from './syntheticContributors.js';
import { broadcastState, broadcastProgress } from './broadcast.js';

const POLL_INTERVAL_MS = 4000;
// Advance a little before the track actually ends so there's no dead-air
// gap while we wait for Spotify to confirm the next PUT /play call.
const END_OF_TRACK_LEAD_MS = 2500;
// A queued track gets this many in-place retries before it's pushed behind
// anything that hasn't failed yet, and this many total attempts before
// Jukebox Republic gives up on it entirely - see pickNextQueueItem.
const RETRY_DEMOTION_THRESHOLD = 2;
const MAX_TRANSIENT_FAILURES = 5;
// An idle session (nobody connected AND nothing playing) still needs an
// occasional look in case the host comes back, but polling it every 4s
// forever burns Spotify calls for a session everyone walked away from -
// a loop only stops on an explicit "stop spinning".
const IDLE_POLL_EVERY_N_TICKS = 8; // ~32s
// How long a session must look idle before we actually slow down. A car
// in a dead zone looks exactly like an abandoned session - every phone
// drops off and Spotify stops reporting a device - and if we backed off
// during one, a track ending mid-outage could leave up to 30s of silence
// before the next one starts. Real drives on these roads go 10-15 minutes
// without signal, so the grace period is set well past that. Nothing is
// lost by being generous: an abandoned session is abandoned for hours, so
// polling it normally for the first 20 minutes costs almost nothing.
const IDLE_GRACE_TICKS = 300; // ~20 min
// How often a mid-track tick re-anchors everyone's progress bar. Clients
// interpolate from the last anchor on their own clock, so a slower cadence
// is invisible but cuts socket traffic - and, more importantly, the
// Firestore writes those broadcasts used to trigger.
const PROGRESS_BROADCAST_EVERY_N_TICKS = 3; // ~12s

/** sessionId -> { handle, ticks, idleTicks }, so each session's loop can be stopped independently. */
const loops = new Map();

/** Starts the 4s watch loop for a session. No-op if it's already running. */
export function startPlaybackLoop(session, io) {
  if (loops.has(session.id)) return;

  const loop = { handle: null, ticks: 0, idleTicks: 0 };
  loop.handle = setInterval(() => {
    loop.ticks += 1;
    // Any sign of life resets the streak, so backing off takes a sustained
    // absence rather than one bad poll.
    loop.idleTicks = isIdle(session) ? loop.idleTicks + 1 : 0;

    const backedOff = loop.idleTicks > IDLE_GRACE_TICKS;
    if (backedOff && loop.ticks % IDLE_POLL_EVERY_N_TICKS !== 0) return;

    pollAndAdvance(session, io, loop.ticks).catch((err) => {
      console.error(`[playback] session ${session.roomCode} poll failed:`, err.message);
    });
  }, POLL_INTERVAL_MS);

  loops.set(session.id, loop);
}

/** Stops a session's watch loop. Safe to call for a session that never had one. */
export function stopPlaybackLoop(sessionId) {
  const loop = loops.get(sessionId);
  if (loop) clearInterval(loop.handle);
  loops.delete(sessionId);
}

/**
 * Nobody listening and nothing playing - the two things a tick could react
 * to are both absent. Note that a session whose host closed their browser
 * but whose music is still playing is NOT idle: the queue should keep
 * advancing for the car even with every screen off.
 */
function isIdle(session) {
  return connectedGuestCount(session) === 0 && !session.isPlaying;
}

/**
 * One tick of the watch loop: reads what Spotify is actually doing, then
 * either adopts it, advances the queue, or just refreshes progress.
 */
async function pollAndAdvance(session, io, ticks) {
  const accessToken = await ensureFreshToken(session);
  const state = await getPlaybackState(accessToken);

  // Picked up here so the host controls can show "Playing"/"Paused" and
  // grey out whichever button doesn't apply, even when the host pauses or
  // resumes from their own Spotify app instead of Jukebox Republic's buttons.
  const isPlaying = state?.isPlaying ?? null;
  const isPlayingChanged = session.isPlaying !== isPlaying;
  session.isPlaying = isPlaying;

  // Progress is re-anchored to Spotify's own number on every poll; between
  // polls each client interpolates forward on its own clock, so the
  // progress bar looks smooth without asking Spotify more than once every
  // few seconds - and any interpolation drift self-corrects on the next tick.
  if (state) {
    session.progressMs = state.progressMs;
  }

  if (!session.nowPlaying) {
    if (state?.isPlaying && state.track) {
      // The host was already playing something before this session had its
      // first pick - the classic case being "started a song in Spotify,
      // THEN created the session". Adopt it exactly like a mid-session
      // manual takeover (below) instead of talking over it with the queue
      // or the Autopilot Mix; the queue takes over when this track ends.
      // A *paused* leftover track deliberately doesn't count - starting a
      // session is a request for music, and adopting something paused
      // would just hold everything silent indefinitely.
      session.nowPlaying = makeSyntheticNowPlaying(state.track, EXTERNAL_CONTRIBUTOR);
      await broadcastState(io, session);
      return;
    }

    if (isPlayingChanged) await broadcastState(io, session);
    // Nothing queued up on our side yet - if the host's device is sitting
    // idle, kick off the first track in the fair queue (or a backup pick).
    await tryStartNext(session, io);
    return;
  }

  if (!state) {
    if (isPlayingChanged) await broadcastState(io, session);
    return; // host's device went away (asleep, disconnected) - just wait for it to come back
  }

  if (state.track.uri !== session.nowPlaying.uri) {
    // Something's playing that Jukebox Republic didn't pick - most likely the host
    // took manual control (e.g. during a dead zone) rather than a glitch.
    // Rather than yanking it away mid-song, adopt it as the thing we're
    // watching. It's still fully votable, and the very next poll tick's
    // "is it about to finish" check below will reclaim the queue the
    // moment THIS track ends instead of interrupting it.
    session.nowPlaying = makeSyntheticNowPlaying(state.track, EXTERNAL_CONTRIBUTOR);
    await broadcastState(io, session);
    return;
  }

  const trackFinishing = state.progressMs + END_OF_TRACK_LEAD_MS >= session.nowPlaying.durationMs;
  if (trackFinishing) {
    await advanceToNext(session, io);
  } else if (ticks % PROGRESS_BROADCAST_EVERY_N_TICKS === 0) {
    await broadcastProgress(io, session);
  }
}

/**
 * Picks what plays next: the fairly-ordered queue if it has anything,
 * otherwise a cycling pick from the session's Autopilot Mix. Returns whether
 * it actually got something going, so callers (and the poll loop) know
 * whether to keep waiting or move on.
 */
async function tryStartNext(session, io) {
  const next = pickNextQueueItem(session.queue, session.queueMode);
  const usingFallback = !next;

  const accessToken = await ensureFreshToken(session);

  // The pool top-up and the device lookup are independent Spotify calls -
  // no reason to wait for one before starting the other. Only picking a
  // fallback track truly depends on the top-up finishing (it may add to
  // fallbackTracks); when no top-up is needed this just resolves instantly
  // and behaves exactly like awaiting resolveTargetDevice alone.
  const needsTopUp = usingFallback && session.fallbackTracks.length === 0;
  const [, deviceId] = await Promise.all([
    needsTopUp ? topUpAutopilotMix(session, accessToken) : Promise.resolve(),
    resolveTargetDevice(accessToken),
  ]);

  const fallbackTrack = usingFallback ? nextFallbackTrack(session) : null;
  const trackToPlay = next || fallbackTrack;

  if (!trackToPlay) return false;

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

    // Two genuinely different retry policies, picked by source rather than
    // interleaved on one shared code path - see each function for why.
    if (usingFallback) {
      retryFallbackTrack(session, trackToPlay);
    } else {
      retryQueueItem(session, trackToPlay, err);
    }

    await broadcastState(io, session);
    return false;
  }

  session.playbackBlockedReason = null;
  session.nowPlaying = usingFallback ? makeSyntheticNowPlaying(trackToPlay, FALLBACK_CONTRIBUTOR) : trackToPlay;
  // The track just started - reset progress to zero immediately rather than
  // leaving the previous track's number showing until the next poll tick.
  session.progressMs = 0;
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
 * MAX_TRANSIENT_FAILURES - see retryQueueItem below).
 */
function pickNextQueueItem(queue, queueMode) {
  const ordered = sortQueue(queue, queueMode);
  return (
    ordered.find((item) => item.playFailures < RETRY_DEMOTION_THRESHOLD) ||
    ordered.find((item) => item.playFailures >= RETRY_DEMOTION_THRESHOLD) ||
    null
  );
}

/** Autopilot Mix picks always get a second chance, moved to the back of the line rather than dropped - the whole point of the mix is to never need active management, so it should be forgiving. */
function retryFallbackTrack(session, trackToPlay) {
  moveFallbackTrackToEnd(session, trackToPlay.uri);
}

/**
 * A real queue item's failure gets classified. A permanent rejection
 * (region lock, a restriction, a removed/invalid uri) is dropped
 * immediately - retrying changes nothing, so there's no reason to make
 * whoever added it wait it out. A transient one (network blip, Spotify
 * 5xx, rate limit) is worth retrying: pickNextQueueItem demotes it once
 * playFailures crosses RETRY_DEMOTION_THRESHOLD, and it's dropped outright
 * past MAX_TRANSIENT_FAILURES so one broken song can't stall the queue
 * forever. Previously any failure here just threw, got swallowed by the
 * poll loop's catch, and left the same broken track stuck at the front
 * forever, retried identically every 4s.
 */
function retryQueueItem(session, trackToPlay, err) {
  if (classifyPlaybackError(err) === 'permanent') {
    session.queue = session.queue.filter((item) => item.id !== trackToPlay.id);
    return;
  }
  trackToPlay.playFailures += 1;
  if (trackToPlay.playFailures >= MAX_TRANSIENT_FAILURES) {
    session.queue = session.queue.filter((item) => item.id !== trackToPlay.id);
  }
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

/** Autopilot Mix tracks are taken in order (not randomly) so it's predictable, and each one is used at most once per session. */
function nextFallbackTrack(session) {
  return session.fallbackTracks[0] || null;
}

/**
 * Pulls in one more hardcoded seed playlist - whichever hasn't been used
 * this session yet - once the pool's fully drained. Each playlist is only
 * ever attempted once per session (marked used before the fetch, success or
 * failure), so a failing fetch doesn't get retried every 4s for the rest
 * of the drive. Once every hardcoded playlist has been used,
 * nextUnusedSeedPlaylist returns null and this becomes a cheap no-op.
 */
async function topUpAutopilotMix(session, accessToken) {
  const next = nextUnusedSeedPlaylist(session.usedSeedPlaylistIds);
  if (!next) return;
  session.usedSeedPlaylistIds.push(next.id);

  try {
    const tracks = await getPlaylistTracks(accessToken, next.id);
    addToFallbackTracks(session, tracks);
    console.log(
      `[playback] session ${session.roomCode} topped up Autopilot Mix from "${next.label}" (${session.fallbackTracks.length} tracks now in pool)`
    );
  } catch (err) {
    console.error(`[playback] session ${session.roomCode} failed to top up Autopilot Mix from "${next.label}":`, err.message);
  }
}

/**
 * Picks which Connect device to send playback to. getPlaybackState only
 * reports a device once something is already playing/paused there, which
 * is useless when starting a session from cold - so this asks Spotify for
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
    addToPlayHistory(session, session.nowPlaying, { votedOut });
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
