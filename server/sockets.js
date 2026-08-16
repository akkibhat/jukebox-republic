// Real-time layer: everything that happens after a guest has already joined
// a session (adding tracks, voting, host controls) flows through here.
// Searching Spotify and the initial join handshake go over plain HTTP
// (routes/api.js) since they're simple request/response - only things that
// need to push updates to everyone in the car go over sockets.
import {
  getSession,
  upsertGuest,
  connectedGuestCount,
  makeQueueItem,
  detectDuplicate,
  addToSkippedSongs,
  removeFromSkippedSongs,
  removeFromFallbackTracks,
  addToFallbackTracks,
  endSession,
} from './sessionStore.js';
import { nextRoundForGuest, applyVote } from './queueFairness.js';
import { buildSessionRecap } from './sessionRecap.js';
import { broadcastState, roomName } from './broadcast.js';
import { startPlaybackLoop, stopPlaybackLoop, skipCurrentTrack } from './playbackEngine.js';
import {
  pausePlayback,
  resumePlayback,
  setVolume,
  getPlaylistTracks,
  getAvailableDevices,
  transferPlayback,
  createPlaylist,
  addTracksToPlaylist,
} from './spotifyApi.js';
import { ensureFreshToken } from './spotifyAuth.js';

// How long a guest whose socket disconnects still counts as "connected" -
// and so still counts toward the downvote threshold and the guest list -
// before we give up on them. Long enough that someone at a party who's
// off eating, chatting, or just on their phone for other reasons doesn't
// silently drop out of the vote the moment their screen locks (which
// kills the connection well before they'd notice or think to reconnect).
// If they reconnect within the window - the ordinary "closed the tab,
// opened it again" case - nothing about the count ever visibly changes
// for anyone else. This deliberately does NOT try to solve a real dead
// zone (see the 20-minute idle-poll grace in playbackEngine.js for that
// - a different problem, since there the guest's OWN experience is what
// matters, not everyone else's vote threshold) - it's sized for "went
// quiet at a gathering", not "lost signal for a while".
const GUEST_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 min

// sessionId:guestId -> pending setTimeout handle. Kept outside the
// session object (like playbackEngine.js's own loop handles) since a
// Timeout isn't something Firestore can serialize - it would break
// persistence for any session with a currently-grace-period guest.
const pendingDisconnects = new Map();

/** Cancels a guest's pending "give up on them" timer, if one is running - called the moment they're confirmed gone for a real reason (they reconnected, or the session ended). */
function cancelPendingDisconnect(sessionId, guestId) {
  const key = `${sessionId}:${guestId}`;
  clearTimeout(pendingDisconnects.get(key));
  pendingDisconnects.delete(key);
}

/**
 * Drops a guest from the live count - not banned, so if they reconnect
 * later upsertGuest welcomes them back exactly like any other rejoin.
 * Shared by three triggers that all ultimately do the same thing: the
 * disconnect grace timer expiring on its own, a kick, and the host's
 * manual "mark as left" action doing immediately what the grace timer
 * would eventually do anyway. Errors are swallowed here (logged, not
 * thrown) so every call site can fire this without its own try/catch -
 * safe to call without awaiting, though callers already in an async
 * context can await it for cleaner sequencing.
 */
function dropGuest(io, session, guest) {
  guest.connected = false;
  return broadcastState(io, session).catch((err) => {
    console.error(`[sockets] broadcast after dropping guest ${guest.id} failed:`, err.message);
  });
}

/** Wires up every real-time event a connected phone can send. Called once at startup. */
export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('join', async ({ sessionId, guestId, name, isHost }, ack) => {
      const session = getSession(sessionId);
      if (!session) return ack?.({ error: 'This session has ended, or the code is wrong.' });
      if (session.bannedGuestIds.has(guestId)) {
        return ack?.({ error: 'The host removed you from this session.' });
      }

      // They're back - if a grace-period timer was counting down from an
      // earlier disconnect, it no longer applies.
      cancelPendingDisconnect(sessionId, guestId);

      const guest = upsertGuest(session, guestId, name);
      socket.data.sessionId = sessionId;
      socket.data.guestId = guest.id;
      // Trusted client-side flag, not real auth: the only person who ever
      // gets a link with `isHost` in it is whoever just came back from the
      // Spotify login redirect. For a car full of friends, that's enough -
      // this isn't guarding against anything more adversarial than someone
      // fibbing to skip a song, which the group can just re-add anyway.
      socket.data.isHost = Boolean(isHost);
      socket.join(roomName(sessionId));

      startPlaybackLoop(session, io); // no-op if it's already running

      ack?.({ ok: true, guestId: guest.id, guestName: guest.name });
      await broadcastState(io, session);
    });

    socket.on('queue:add', async ({ track }, ack) => {
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const guest = session.guests.get(socket.data.guestId);
      if (!guest) return ack?.({ error: 'Rejoin the session and try again.' });

      // Duplicates are allowed now, not rejected - sometimes a repeat is
      // intentional, sometimes it's added without realizing it's already
      // queued or already played. Either way it's flagged (see
      // detectDuplicate) rather than blocked, and anyone can pull it back
      // out below, not just whoever added it.
      const duplicateReason = detectDuplicate(session, track.uri);

      const round = nextRoundForGuest(guest);
      const item = makeQueueItem({ track, guest, round, duplicateReason });
      session.queue.push(item);
      removeFromSkippedSongs(session, track.uri); // re-adding a skipped song takes it off that list
      removeFromFallbackTracks(session, track.uri); // promoted to the real queue - out of the Autopilot Mix pool

      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    // A guest can pull their own submission back out any time before it
    // plays, no group vote needed - that's just changing your mind, not a
    // democratic rejection, so it doesn't touch the skipped list either.
    // A flagged duplicate is the one exception to "only the adder can
    // remove it" - it was often added without realizing it's a repeat, so
    // anyone in the car can clear it rather than waiting on the adder to
    // notice.
    socket.on('queue:remove', async ({ itemId }, ack) => {
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const item = session.queue.find((q) => q.id === itemId);
      if (!item) return ack?.({ error: 'That track is no longer in the queue.' });
      if (item.addedBy.id !== socket.data.guestId && !item.duplicateReason) {
        return ack?.({ error: 'You can only remove songs you added.' });
      }

      session.queue = session.queue.filter((q) => q.id !== itemId);
      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    socket.on('queue:vote', async ({ itemId, direction }, ack) => {
      if (direction !== 'up' && direction !== 'down') {
        return ack?.({ error: 'Vote must be up or down.' });
      }
      const session = getSession(socket.data.sessionId);
      if (!session) return ack?.({ error: 'Session not found.' });

      const guestId = socket.data.guestId;
      const guestCount = connectedGuestCount(session);

      const target =
        session.nowPlaying?.id === itemId
          ? { item: session.nowPlaying, isNowPlaying: true }
          : { item: session.queue.find((q) => q.id === itemId), isNowPlaying: false };

      if (!target.item) return ack?.({ error: 'That track is no longer in the queue.' });

      const result = applyVote(target.item, guestId, direction, guestCount);

      if (result.rejected) return ack?.({ error: result.reason });

      ack?.({ ok: true });

      if (result.shouldRemove && target.isNowPlaying) {
        await skipCurrentTrack(session, io, { votedOut: true }); // broadcasts state itself once the next track starts
      } else if (result.shouldRemove) {
        session.queue = session.queue.filter((q) => q.id !== itemId);
        addToSkippedSongs(session, target.item);
        await broadcastState(io, session);
      } else {
        await broadcastState(io, session);
      }
    });

    // --- Host/co-host playback overrides ---------------------------------
    // The driver should always be able to skip or pause regardless of what
    // the vote threshold says - the group's vote is a way for everyone
    // *else* to weigh in, not a way to lock the driver out of their own
    // stereo. A promoted co-host shares these powers (see cohost:set) -
    // the "let my passenger manage the stereo" case.

    socket.on('playback:skip', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;
      try {
        await skipCurrentTrack(session, io);
        ack?.({ ok: true });
      } catch (err) {
        console.error('[sockets] playback:skip failed:', err.message);
        ack?.({ error: 'Could not skip. Try again in a moment.' });
      }
    });

    socket.on('playback:pause', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;
      await runPlaybackCommand(session, io, ack, { verb: 'pause', call: pausePlayback, isPlayingAfter: false });
    });

    socket.on('playback:resume', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;
      await runPlaybackCommand(session, io, ack, { verb: 'resume', call: resumePlayback, isPlayingAfter: true });
    });

    // The "law of the land" switch: how the queue orders itself. Host-only
    // like the playback overrides - the group votes on songs, but the host
    // picks which voting system is in effect.
    socket.on('queue:mode', async ({ mode }, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;
      if (mode !== 'fair' && mode !== 'crowd') return ack?.({ error: 'Unknown queue mode.' });

      session.queueMode = mode;
      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    socket.on('playback:volume', async ({ percent }, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;

      const requested = Number(percent);
      if (!Number.isFinite(requested)) return ack?.({ error: 'Volume must be a number.' });
      const clamped = Math.max(0, Math.min(100, Math.round(requested)));

      try {
        const accessToken = await ensureFreshToken(session);
        await setVolume(accessToken, clamped);
        ack?.({ ok: true });
      } catch (err) {
        console.error('[sockets] playback:volume failed:', err.message);
        // 403 here means the current device refuses remote volume changes
        // (a hardware/platform restriction), not a transient failure -
        // no point suggesting a retry for that one.
        ack?.({
          error:
            err.status === 403
              ? "This playback device doesn't allow volume control."
              : 'Could not change volume. Try again in a moment.',
        });
      }
    });

    // Lists every Spotify Connect device the host's account can currently
    // see, fetched on demand (not pushed/polled) since it's only needed
    // while the host actually has the picker open.
    socket.on('playback:devices', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;

      try {
        const accessToken = await ensureFreshToken(session);
        const devices = await getAvailableDevices(accessToken);
        ack?.({ ok: true, devices });
      } catch (err) {
        console.error('[sockets] playback:devices failed:', err.message);
        ack?.({ error: 'Could not load devices. Try again in a moment.' });
      }
    });

    // Manual override for which device playback goes to - see
    // transferPlayback's comment for why this exists (Spotify's own
    // auto-pick can hand off to a TV/speaker instead of a screen-off phone).
    socket.on('playback:setDevice', async ({ deviceId }, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;
      if (!deviceId) return ack?.({ error: 'No device selected.' });

      try {
        const accessToken = await ensureFreshToken(session);
        await transferPlayback(accessToken, deviceId);
        ack?.({ ok: true });
      } catch (err) {
        console.error('[sockets] playback:setDevice failed:', err.message);
        ack?.({ error: 'Could not switch devices. Try again in a moment.' });
      }
    });

    /**
     * Saves everything that's played this session as a private playlist on
     * the host's own Spotify account - explicitly opt-in (a button in the
     * History tab, and a confirm prompt right before "Stop spinning" - see
     * host.js) rather than automatic, since not every drive is worth a
     * permanent playlist. True-host-only: it writes to the host's personal
     * library, not something a co-host should trigger on their behalf.
     * Oldest-first order (playHistory is stored newest-first, for the UI
     * list) so the playlist reads like the night actually went.
     */
    socket.on('history:export', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;
      if (session.playHistory.length === 0) return ack?.({ error: "Nothing's played yet." });

      try {
        const accessToken = await ensureFreshToken(session);
        const date = new Date().toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
        const playlist = await createPlaylist(
          accessToken,
          session.host.spotifyId,
          `Jukebox Republic — ${date}`,
          `Played in session ${session.roomCode} - made with Jukebox Republic.`
        );
        const uris = [...session.playHistory].reverse().map((item) => item.uri);
        await addTracksToPlaylist(accessToken, playlist.id, uris);
        ack?.({ ok: true, url: playlist.externalUrl });
      } catch (err) {
        console.error(`[sockets] history:export failed for ${session.roomCode}:`, err.message);
        ack?.({ error: 'Could not save to Spotify. Try again in a moment.' });
      }
    });

    /**
     * Pulls an arbitrary playlist's tracks into the Autopilot Mix pool.
     * True-host-only by design (guests shape the real queue; the fallback
     * mix is the host's to curate). The playlist id arrives from either
     * the host's in-app playlist search or a pasted Spotify link - both
     * funnel through the same validation here.
     */
    socket.on('autopilot:addPlaylist', async ({ playlistId }, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;

      const id = String(playlistId || '').trim();
      if (!/^[A-Za-z0-9]+$/.test(id)) {
        return ack?.({ error: "That doesn't look like a Spotify playlist." });
      }
      // Editorial/algorithmic playlists 404 on the tracks endpoint in Dev
      // Mode (verified live) - reject up front with a useful explanation
      // instead of a generic failure after the fetch.
      if (id.startsWith('37i9dQZF1D')) {
        return ack?.({ error: "Spotify's own editorial playlists can't be read by the API - pick a community-made one instead." });
      }
      if (session.usedSeedPlaylistIds.includes(id)) {
        return ack?.({ error: "That playlist is already part of this session's mix." });
      }

      try {
        const accessToken = await ensureFreshToken(session);
        const tracks = await getPlaylistTracks(accessToken, id);
        if (tracks.length === 0) {
          return ack?.({ error: 'That playlist has no playable tracks.' });
        }

        const before = session.fallbackTracks.length;
        addToFallbackTracks(session, tracks); // dedupes against what's already pooled
        // Marked used only after a successful fetch - unlike the seed-at-
        // login flow (which marks first so the 4s poll loop can't retry a
        // failing fetch forever), this is a one-shot user action and a
        // transient failure SHOULD be retryable.
        session.usedSeedPlaylistIds.push(id);

        ack?.({ ok: true, added: session.fallbackTracks.length - before });
        await broadcastState(io, session);
      } catch (err) {
        console.error('[sockets] autopilot:addPlaylist failed:', err.message);
        ack?.({
          error:
            err.status === 404
              ? "Spotify couldn't find that playlist. Private playlists and editorial mixes aren't readable."
              : 'Could not load that playlist. Try again in a moment.',
        });
      }
    });

    // --- Moderation ------------------------------------------------------

    /**
     * The graceful case - "they've left the party" - not a moderation
     * action, just doing right now what their disconnect grace timer
     * would eventually do on its own. Not banned: if they reconnect
     * later they're welcomed back like anyone else. Deliberately doesn't
     * touch their live socket even if it's technically still open -
     * forcing a disconnect would just trigger their own client's
     * automatic reconnect and silently undo this, since join has no
     * reason to refuse them. For the "actually needs to be kept out"
     * case, see guest:kick below.
     */
    socket.on('guest:remove', async ({ guestId }, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;

      const resolved = await resolveRemovalTarget(io, session, socket, guestId, ack, 'remove');
      if (!resolved) return;

      cancelPendingDisconnect(session.id, guestId); // this supersedes any timer already counting down for them
      ack?.({ ok: true });
      await dropGuest(io, session, resolved.target);
    });

    /**
     * Kicking bans the guest id and drops every connection it has open -
     * for someone who actually needs to be kept out, not just marked as
     * having left (see guest:remove above for that). Their already-
     * queued songs stay (the user's call: the music was presumably fine,
     * the person was the problem), and history keeps their name. Soft by
     * design - a determined kicked guest can clear localStorage for a
     * fresh id, but this is moderation for a car full of friends, not an
     * adversarial system.
     */
    socket.on('guest:kick', async ({ guestId }, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;

      const resolved = await resolveRemovalTarget(io, session, socket, guestId, ack, 'kick');
      if (!resolved) return;
      const { target, targetSockets } = resolved;

      session.bannedGuestIds.add(guestId);
      session.coHostIds.delete(guestId); // a kicked co-host loses their powers too
      for (const s of targetSockets) {
        s.emit('kicked'); // tell them why before the connection drops, so their screen can say so
        s.disconnect(true);
      }

      ack?.({ ok: true });
      await dropGuest(io, session, target);
    });

    /**
     * Promote or demote a co-host. True-host-only (not co-hosts - powers
     * that can mint more powers stay with the person whose Spotify account
     * is on the line). Playback keeps running on the host's account either
     * way; this only shares the control buttons.
     */
    socket.on('cohost:set', async ({ guestId, promote }, ack) => {
      const session = requirePermission(socket, ack, 'host');
      if (!session) return;

      const target = session.guests.get(guestId);
      if (!target) return ack?.({ error: 'That guest is not in this session.' });

      if (promote) session.coHostIds.add(guestId);
      else session.coHostIds.delete(guestId);

      ack?.({ ok: true });
      await broadcastState(io, session);
    });

    socket.on('session:end', async (_payload, ack) => {
      const session = requirePermission(socket, ack, 'coHost');
      if (!session) return;

      try {
        const accessToken = await ensureFreshToken(session);
        await pausePlayback(accessToken);
      } catch (err) {
        // Not fatal - the session ends either way. This is just a courtesy so
        // the car doesn't keep playing after everyone's done with Jukebox Republic;
        // if the host's phone is already asleep or offline, there's no
        // device to pause anyway.
        console.error(`[sockets] session:end could not pause playback for ${session.roomCode}:`, err.message);
      }

      // The recap has to be built (and sent) before endSession wipes the
      // state it's computed from - clients render it after the fact from
      // this payload alone.
      const room = roomName(session.id);
      io.in(room).emit('session:ended', buildSessionRecap(session));
      stopPlaybackLoop(session.id);
      // Nobody's pending grace timer should fire against a session that's
      // about to be deleted - it would try to write a since-removed
      // session back into Firestore.
      for (const guestId of session.guests.keys()) cancelPendingDisconnect(session.id, guestId);
      endSession(session.id);
      ack?.({ ok: true });
      // Force every socket (guests and the host) off the room now that the
      // session is gone - an idle open socket would otherwise keep sitting
      // there with nothing to do, and on Cloud Run it'd count as an active
      // connection keeping the instance from scaling to zero.
      io.in(room).disconnectSockets(true);
    });

    socket.on('disconnect', () => {
      const session = getSession(socket.data.sessionId);
      if (!session) return;
      const guest = session.guests.get(socket.data.guestId);
      if (!guest) return;

      // A banned guest can't legitimately reconnect (join rejects them
      // outright), so there's nothing to wait for - drop them for real
      // immediately rather than scheduling a pointless grace timer. This
      // also covers a kick's own disconnect(), which fires this same
      // handler on the target's socket.
      if (session.bannedGuestIds.has(guest.id)) {
        dropGuest(io, session, guest);
        return;
      }

      // Otherwise, give them GUEST_GRACE_PERIOD_MS to come back before
      // actually dropping them from the count - see the constant's
      // comment for why. Nothing broadcasts yet: as far as everyone
      // else's screen is concerned, nothing has changed until this
      // timer actually fires.
      const key = `${session.id}:${guest.id}`;
      pendingDisconnects.set(
        key,
        setTimeout(() => {
          pendingDisconnects.delete(key);
          dropGuest(io, session, guest);
        }, GUEST_GRACE_PERIOD_MS)
      );
    });
  });
}

/**
 * Shared validation for guest:remove and guest:kick, which differ only in
 * what happens to the target after this point (kick additionally bans and
 * disconnects; remove doesn't - see each handler's own comment). Looks up
 * the target, rejects removing yourself or the host, and resolves the
 * target's live sockets (kick needs them to disconnect; remove ignores
 * them deliberately). Acks a `verb`-specific error and returns null on
 * any failure, so callers can `if (!resolved) return;`.
 */
async function resolveRemovalTarget(io, session, socket, guestId, ack, verb) {
  const target = session.guests.get(guestId);
  if (!target) {
    ack?.({ error: 'That guest is not in this session.' });
    return null;
  }
  if (guestId === socket.data.guestId) {
    ack?.({ error: `You can't ${verb} yourself.` });
    return null;
  }

  const sockets = await io.in(roomName(session.id)).fetchSockets();
  const targetSockets = sockets.filter((s) => s.data.guestId === guestId);
  if (targetSockets.some((s) => s.data.isHost)) {
    ack?.({ error: `You can't ${verb} the host.` });
    return null;
  }

  return { target, targetSockets };
}

/**
 * Shared body for the pause/resume handlers above, which differ only in
 * which Spotify call they make and which way isPlaying ends up.
 */
async function runPlaybackCommand(session, io, ack, { verb, call, isPlayingAfter }) {
  try {
    const accessToken = await ensureFreshToken(session);
    await call(accessToken);
    // Set optimistically rather than waiting for the next poll tick (up to
    // 4s away) to pick it up - the command already succeeded, so there's
    // no reason the button state should lag behind it.
    session.isPlaying = isPlayingAfter;
    ack?.({ ok: true });
    await broadcastState(io, session);
  } catch (err) {
    console.error(`[sockets] playback:${verb} failed:`, err.message);
    ack?.({ error: `Could not ${verb}. Is Spotify open on the host phone?` });
  }
}

/**
 * Looks up the caller's session and confirms they hold at least `level`,
 * acking a specific error and returning null if not.
 *
 * - `'host'`: the true host only. For anything that changes who holds
 *   power (cohost:set), the session's rules (queue:mode), or the host's
 *   own device (playback:volume) - a co-host shouldn't be able to grant
 *   itself more power or change the rules everyone else agreed to.
 * - `'coHost'`: the host OR a promoted co-host. For powers that are
 *   already granted and just get shared (pause/resume/skip/kick/end) -
 *   the "let my passenger manage the stereo" case.
 */
function requirePermission(socket, ack, level) {
  const session = getSession(socket.data.sessionId);
  if (!session) {
    ack?.({ error: 'Session not found.' });
    return null;
  }

  const isHost = socket.data.isHost;
  const isCoHost = session.coHostIds.has(socket.data.guestId);

  if (level === 'host' && !isHost) {
    ack?.({ error: 'Only the host can do that.' });
    return null;
  }
  if (level === 'coHost' && !isHost && !isCoHost) {
    ack?.({ error: 'Only the host or a co-host can do that.' });
    return null;
  }
  return session;
}
