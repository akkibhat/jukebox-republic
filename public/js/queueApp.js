// Shared logic between host.html and guest.html - once a sessionId is known
// (the host gets it from its own URL, a guest resolves it from a room
// code), the experience is identical except the host also gets playback
// override buttons. Both pages call startQueueApp() once they know which
// session to join.
import { getOrCreateGuestId, getStoredName, setStoredName } from './identity.js';

const SEARCH_DEBOUNCE_MS = 300;

// Firebase Hosting's rewrite to Cloud Run is HTTP-only - it doesn't proxy
// WebSocket upgrades, so connecting same-origin through music.pi.co.nz
// silently downgrades Socket.io to long-polling (a full HTTP round-trip per
// vote or queue action instead of a message over an already-open socket).
// Connecting straight to the Cloud Run service's own origin gets native
// WebSockets; static pages/CSS/JS still load from Firebase's CDN as normal,
// only the live socket bypasses it. Local dev (server and client on the
// same origin) has no such CDN in the way, so same-origin stays correct there.
const SOCKET_ORIGIN =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? undefined
    : 'https://jukebox-republic-server-902180962093.australia-southeast1.run.app';

// Set once per page load by startQueueApp - host.html and guest.html each
// load their own instance of this module, so these never leak between them.
let isHostView = false;
let myGuestId = null;

// Whether THIS connection may use the host's playback/kick powers - true
// for the host and for a promoted co-host. Comes from the server with
// every state broadcast (so promotion/demotion takes effect live), and the
// server re-checks every action anyway; this only decides which buttons
// render.
let havePowers = false;

// Caches for the "read-only list with a button that sends it to the main
// queue" sections (Autopilot Mix, skipped songs, play history) - a click
// only carries a list id + index, so this is where the full track objects
// live to look up when that fires. Same trick runSearch uses for its own
// results.
const readdCaches = { 'autopilot-list': [], 'skipped-list': [], 'history-list': [] };

// The last known playback position, anchored to *this device's* clock at
// the moment the state broadcast arrived. The server re-sends the real
// number every poll tick (~4s); between ticks a small timer walks the bar
// forward from this anchor, so it moves smoothly instead of jumping every
// few seconds. Using the client's own receive-time (rather than a server
// timestamp) sidesteps clock skew between phones entirely.
let progressAnchor = null;

// Set once the session ends (either this client ended it, or the host did)
// so the disconnect handler below can tell a normal end-of-session hangup
// apart from a real dropout - without this, the forced disconnect the
// server sends on session:end would trigger the same "Offline -
// reconnecting…" banner as driving through a dead zone, and Socket.io
// would keep retrying a session that no longer exists.
let sessionEnded = false;

/**
 * Joins the session and wires up the whole real-time UI. Returns a promise
 * that resolves with the connected socket once the join succeeds, so a
 * caller (host.js, for the "Stop spinning" button) can piggyback host-only
 * actions onto the same connection instead of opening a second one.
 */
export function startQueueApp(sessionId, { isHost = false } = {}) {
  isHostView = isHost;
  myGuestId = getOrCreateGuestId();

  return ensureName().then(
    (name) =>
      new Promise((resolve) => {
        const socket = io(SOCKET_ORIGIN); // see SOCKET_ORIGIN comment above

        // Fires on the first connection AND on every automatic reconnect,
        // so rejoining after a dead zone needs no special handling - the
        // same join re-registers this guest and pulls fresh state down.
        socket.on('connect', () => {
          socket.emit('join', { sessionId, guestId: myGuestId, name, isHost }, (response) => {
            if (response?.error) {
              // The session ended (or we were kicked) while we were away.
              renderFatalError(response.error);
              return;
            }
            setConnectionBanner(null);
            resolve(socket);
          });
        });

        // Long outages are normal on the roads this gets used on, so say
        // so plainly instead of leaving a frozen UI that looks broken.
        // Socket.io retries on its own, indefinitely, with backoff.
        socket.on('disconnect', () => {
          if (sessionEnded) return;
          setConnectionBanner('Offline - reconnecting…');
        });
        socket.io.on('reconnect_attempt', () => {
          if (sessionEnded) return;
          setConnectionBanner('Offline - reconnecting…');
        });

        socket.on('state', renderState);
        socket.on('progress', updateProgress);
        socket.on('session:ended', (recap) => {
          sessionEnded = true;
          socket.io.reconnection(false); // the room is gone - stop retrying against it
          renderSessionEnded(recap);
        });
        socket.on('kicked', () => renderFatalError('The host removed you from this session.'));
        socket.on('history:exported', () => showToast('Host saved tonight\'s playlist to Spotify'));

        wireSearch(sessionId, socket);
        wirePlaylistSearch(sessionId, socket);
        wireClicks(socket);
        wireTabs();

        // Walks the progress bar forward between server updates. Updates
        // two elements in place rather than re-rendering the card, so it
        // never interferes with buttons mid-tap.
        setInterval(tickProgressBar, 500);
      })
  );
}

// --- Name capture -----------------------------------------------------

/** Resolves once we know what to call this guest, prompting only if they haven't joined before. */
function ensureName() {
  const existing = getStoredName();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const overlay = document.getElementById('name-prompt');
    const input = document.getElementById('name-input');
    const form = document.getElementById('name-form');
    overlay.style.display = 'flex';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      setStoredName(name);
      overlay.style.display = 'none';
      resolve(name);
    });
  });
}

// --- Rendering ----------------------------------------------------------

/**
 * Shows or clears the offline banner. Pass null once we're back.
 *
 * While offline the progress bar is frozen deliberately: it would
 * otherwise keep interpolating forward from a stale anchor and drift out
 * of step with whatever is actually playing.
 */
function setConnectionBanner(message) {
  let banner = document.getElementById('connection-banner');
  if (!message) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'connection-banner';
    banner.className = 'connection-banner';
    document.body.appendChild(banner);
  }
  banner.textContent = message;
  if (progressAnchor) progressAnchor.playing = false;
}

/**
 * Handles the lightweight 'progress' event (see broadcastProgress
 * server-side) - just re-anchors the interpolation timer's starting
 * point without repainting anything, since nothing else changed.
 */
function updateProgress({ progressMs, isPlaying }) {
  if (!progressAnchor) return; // no track context yet - a full 'state' event establishes that first
  progressAnchor = { ...progressAnchor, baseMs: progressMs, anchoredAt: Date.now(), playing: isPlaying === true };
}

/** Entry point for every server update - repaints the whole UI from one state payload. */
function renderState(state) {
  havePowers = Boolean(state.youHavePowers);

  const guestCountEl = document.getElementById('guest-count');
  if (guestCountEl) {
    guestCountEl.textContent = `${state.connectedGuestCount} connected`;
  }
  renderGuestChips(state.guests || []);
  renderBannedGuests(state.bannedGuests || []);
  renderVolumeControls(state);

  // Re-anchor the progress bar to the server's number the moment it
  // arrives; the tick timer takes over from here until the next update.
  progressAnchor =
    state.nowPlaying && typeof state.progressMs === 'number'
      ? {
          baseMs: state.progressMs,
          anchoredAt: Date.now(),
          durationMs: state.nowPlaying.durationMs,
          playing: state.isPlaying === true,
        }
      : null;

  renderNowPlaying(state.nowPlaying, state.playbackBlockedReason, state.isPlaying, state.progressMs);
  renderQueueModeBars(state.queueMode);
  renderQueue(state.queue, (state.fallbackTracks || []).length > 0);
  renderReaddableList('autopilot-list', state.fallbackTracks, 'Add to queue', 'Nothing in the Autopilot Mix right now.');
  renderReaddableList('skipped-list', state.skippedSongs, 'Re-add', 'Nothing skipped yet.');
  renderReaddableList('history-list', state.playHistory, 'Re-add', 'Nothing played yet.', {
    goldenId: state.goldenRecordId,
  });
}

/**
 * The "who's here" row as chips instead of a plain name list. Everyone
 * sees names and a co-host star; the true host's star is also the
 * promote/demote toggle (filled when the guest already holds co-host
 * powers, outline otherwise), so it doubles as status and control
 * instead of showing a separate static badge next to it. (The server
 * enforces all of it regardless - this button is just an affordance.)
 */
function renderGuestChips(guests) {
  const el = document.getElementById('guest-names');
  if (!el) return;

  el.innerHTML = guests
    .map((guest) => {
      const isMe = guest.id === myGuestId;
      const showsPromote = isHostView && !isMe;
      // Only shown when the promote button (below) isn't already
      // conveying co-host status via its filled state.
      const badge = !showsPromote && guest.isCoHost ? iconHtml('star', 'icon cohost-badge') : '';
      const promote = showsPromote
        ? `<button class="chip-action promote-button${guest.isCoHost ? ' promote-button-active' : ''}" data-guest-id="${guest.id}" data-promote="${guest.isCoHost ? 'false' : 'true'}" title="${guest.isCoHost ? 'Remove co-host powers' : 'Make co-host'}">${iconHtml('star')}</button>`
          : '';
      const kick =
        havePowers && !isMe
          ? `<button class="chip-action kick-button" data-guest-id="${guest.id}" data-guest-name="${escapeHtml(guest.name)}" title="Tap to mark as left - hold to remove and ban">${iconHtml('leave')}</button>`
          : '';
      return `<span class="guest-chip">${escapeHtml(guest.name)}${isMe ? ' (you)' : ''}${badge}${promote}${kick}</span>`;
    })
    .join('');
}

/**
 * Whoever got kicked, with a one-tap way to undo it - the only previous
 * recovery path was the banned guest themselves knowing to clear their
 * browser storage for a fresh id. Same visibility rule as the kick button
 * itself (havePowers, not isHostView, so a promoted co-host on guest.html
 * sees this too); hidden entirely when there's nothing banned or the
 * viewer has no powers, rather than showing an empty section.
 */
function renderBannedGuests(bannedGuests) {
  const el = document.getElementById('banned-guests');
  if (!el) return;

  if (!havePowers || bannedGuests.length === 0) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="banned-guests-label">Banned</div>
    ${bannedGuests
      .map(
        (guest) => `
          <span class="guest-chip banned-chip">
            ${escapeHtml(guest.name)}
            <button class="chip-action unban-button" data-guest-id="${guest.id}" title="Unban">${iconHtml('x')}</button>
          </span>`
      )
      .join('')}
  `;
}

/**
 * Shows or hides the volume slider based on what the current device
 * supports. Only exists on host.html - guest.html has no volume-controls
 * element, so this is a no-op there. Hidden specifically on a confirmed
 * `false`; `null` means Spotify hasn't reported yet (no active device this
 * tick), which shouldn't make the slider flash away on every brief gap.
 */
function renderVolumeControls(state) {
  const volumeControls = document.getElementById('volume-controls');
  if (!volumeControls) return;
  volumeControls.style.display = state.supportsVolume === false ? 'none' : 'flex';
}

/** The now-playing card: art, votes, progress, and host controls for whoever holds powers. */
function renderNowPlaying(track, playbackBlockedReason, isPlaying, progressMs) {
  const container = document.getElementById('now-playing');
  if (!container) return;

  if (!track) {
    container.innerHTML = playbackBlockedReason
      ? `<p class="empty-state empty-state-warning">${escapeHtml(playbackBlockedReason)}</p>`
      : `<p class="empty-state">Nothing playing yet - add a song to get things spinning.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="now-playing-card" data-item-id="${track.id}">
      <div class="now-playing">
        <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
        <div class="track-info">
          <div class="track-name">${escapeHtml(track.name)}${explicitBadgeHtml(track)}</div>
          <div class="track-artist">${escapeHtml(track.artist)}</div>
          <div class="added-by">${addedByLineHtml(track)}</div>
          ${skipProgressHtml(track)}
        </div>
        ${voteButtonsHtml(track)}
      </div>
      ${progressBarHtml(track, progressMs)}
      ${havePowers ? hostControlsHtml(isPlaying) : ''}
    </div>
  `;
}

/**
 * Rendered with the real position immediately (not zero) so the bar doesn't
 * visibly jump on every state update - the tick timer only ever nudges it
 * forward from here. Hidden entirely until the first poll reports a
 * position, rather than showing a bar stuck at 0:00 that might be wrong.
 */
function progressBarHtml(track, progressMs) {
  if (typeof progressMs !== 'number' || !track.durationMs) return '';
  const pct = Math.min(100, (progressMs / track.durationMs) * 100);
  return `
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width: ${pct}%"></div></div>
    <div class="progress-times"><span id="progress-elapsed">${fmtTime(progressMs)}</span><span>${fmtTime(track.durationMs)}</span></div>
  `;
}

/** Interpolates the bar between server updates - see progressAnchor. */
function tickProgressBar() {
  if (!progressAnchor) return;
  const fill = document.getElementById('progress-fill');
  const elapsed = document.getElementById('progress-elapsed');
  if (!fill || !elapsed) return;

  const ms = Math.min(
    progressAnchor.durationMs,
    progressAnchor.baseMs + (progressAnchor.playing ? Date.now() - progressAnchor.anchoredAt : 0)
  );
  fill.style.width = `${(ms / progressAnchor.durationMs) * 100}%`;
  elapsed.textContent = fmtTime(ms);
}

/** Milliseconds as m:ss. */
function fmtTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/**
 * The "law of the land" banner above the queue, shown on both the Home and
 * Queue tabs (hence a class, not an id): tells everyone which ordering is
 * in effect, and gives the host a Switch button to change it. Fair
 * rotation suits a big group; crowd choice suits a small one where
 * rallying votes is the fun part.
 */
function renderQueueModeBars(mode) {
  const bars = document.querySelectorAll('.queue-mode-bar');
  if (!bars.length) return;

  const isFair = mode !== 'crowd';
  const label = isFair
    ? `${iconHtml('scales', 'icon mode-icon')} Fair rotation &mdash; everyone gets a turn`
    : `${iconHtml('crowd', 'icon mode-icon')} Majority rule &mdash; most upvoted plays first`;
  const toggle = isHostView
    ? `<button class="mode-toggle" data-mode="${isFair ? 'crowd' : 'fair'}" type="button">Switch</button>`
    : '';

  bars.forEach((bar) => {
    bar.innerHTML = `<span class="mode-label">${label}</span>${toggle}`;
  });
}

/** Renders into both #queue-list-home (Home tab) and #queue-list-tab (Queue tab) - same data, same markup, two places to see it. */
function renderQueue(queue, hasAutopilot) {
  const html =
    queue.length === 0
      ? // An empty queue isn't silence - the Autopilot Mix takes over - so
        // say so, otherwise it reads like the music is about to stop. Only
        // promise that when the mix actually has something left in it.
        `<p class="empty-state">${
          hasAutopilot
            ? "Queue's empty &mdash; the Autopilot Mix is keeping the music going. Search below to add a real pick."
            : "Queue's empty. Search below to add the next song."
        }</p>`
      : queue
          .map(
            // The first row is what plays next - it gets a highlighted
            // treatment so the fair-rotation outcome is *visible*, not
            // something you have to infer from the ordering.
            (track, index) => `
              <div class="queue-item ${index === 0 ? 'up-next' : ''}" data-item-id="${track.id}">
                <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
                <div class="track-info">
                  ${index === 0 ? '<div class="up-next-label">Up next</div>' : ''}
                  <div class="track-name">${escapeHtml(track.name)}${explicitBadgeHtml(track)}</div>
                  <div class="track-artist">${escapeHtml(track.artist)}</div>
                  <div class="added-by">${escapeHtml(track.addedBy.name)}</div>
                  ${skipProgressHtml(track)}
                  ${duplicateBadgeHtml(track)}
                </div>
                ${voteButtonsHtml(track)}
                ${track.addedBy.id === myGuestId || track.duplicateReason ? removeButtonHtml() : ''}
              </div>
            `
          )
          .join('');

  const homeList = document.getElementById('queue-list-home');
  const tabList = document.getElementById('queue-list-tab');
  if (homeList) homeList.innerHTML = html;
  if (tabList) tabList.innerHTML = html;
}

/**
 * Renders a read-only track list where every row can be sent into the main
 * queue with one tap - used for the Autopilot Mix preview, the skipped-
 * songs list, and play history, all shaped identically on the wire. Each
 * of these now lives in its own dedicated tab (rather than a section that
 * used to hide itself when empty), so an empty list shows a short message
 * in place of the rows instead of disappearing - the tab itself is always
 * reachable from the tab bar regardless of what's in it.
 */
function renderReaddableList(listId, tracks, buttonLabel, emptyMessage, { goldenId = null } = {}) {
  const list = document.getElementById(listId);
  if (!list) return;

  readdCaches[listId] = tracks || [];

  if (readdCaches[listId].length === 0) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  list.innerHTML = readdCaches[listId]
    .map(
      // Matched by id, not object identity - the same song re-added and
      // re-played gets its own separate history entry (a fresh id), and
      // only the specific play that earned the votes should wear the medal.
      (track, index) => `
        <div class="queue-item skipped-item">
          <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(track.name)}${explicitBadgeHtml(track)}${track.id === goldenId ? goldenBadgeHtml(track) : ''}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
          </div>
          <button class="button button-secondary readd-button" data-list="${listId}" data-index="${index}">${buttonLabel}</button>
        </div>
      `
    )
    .join('');
}

/** The session's most-upvoted played song wears this in the History tab. */
function goldenBadgeHtml(track) {
  return `<svg class="icon golden-badge"><title>Golden record - the session's most upvoted song (+${track.netVotes})</title><use href="#icon-record"/></svg>`;
}

/** An icon from the page's sprite - see the &lt;symbol&gt; defs in host.html / guest.html. */
function iconHtml(name, className = 'icon') {
  return `<svg class="${className}"><use href="#icon-${name}"/></svg>`;
}

/** Up/down buttons with the current net score, highlighting whichever way this guest voted. */
function voteButtonsHtml(track) {
  const upClass = track.myVote === 'up' ? 'active-up' : '';
  const downClass = track.myVote === 'down' ? 'active-down' : '';
  return `
    <div class="vote-buttons">
      <button class="vote-button ${upClass}" data-vote="up" aria-label="Vote up">${iconHtml('vote-up', 'icon vote-icon')}</button>
      <span class="net-votes">${track.netVotes}</span>
      <button class="vote-button ${downClass}" data-vote="down" aria-label="Vote down">${iconHtml('vote-down', 'icon vote-icon')}</button>
    </div>
  `;
}

/** The little x for pulling a song back out - only rendered where removal is allowed. */
function removeButtonHtml() {
  return `<button class="remove-button" title="Remove your song" aria-label="Remove">${iconHtml('x')}</button>`;
}

/** "2 of 3 to skip" - only shown once a track has at least one downvote, so a clean track shows nothing extra. */
function skipProgressHtml(track) {
  if (!track.downvotes) return '';
  return `<div class="skip-progress">${track.downvotes} of ${track.threshold} downvotes to skip</div>`;
}

/**
 * Duplicates are allowed in the queue, not blocked - this just makes sure
 * nobody's surprised by one. Says *why* it's a duplicate (queued/playing/
 * played) rather than a generic label, since that's the difference between
 * "yeah I meant to do that" and "oh, someone already added this."
 */
function duplicateBadgeHtml(track) {
  if (!track.duplicateReason) return '';
  const label = {
    queued: 'Already in queue',
    playing: 'Currently playing',
    played: 'Already played',
  }[track.duplicateReason];
  return `<div class="duplicate-badge">${label}</div>`;
}

/** Small "E" tag next to explicit tracks, everywhere a track name is rendered. */
function explicitBadgeHtml(track) {
  return track.explicit ? '<span class="explicit-badge" title="Explicit">E</span>' : '';
}

/** Only ever shown on now-playing, since these synthetic sources never appear as a queued item. */
function addedByLineHtml(track) {
  if (track.addedBy.id === 'external') return "Playing directly on Spotify - not from the queue";
  if (track.addedBy.id === 'fallback') return 'From the Autopilot Mix';
  return `Added by ${escapeHtml(track.addedBy.name)}`;
}

/**
 * `isPlaying` is null until the first poll comes back or a host action
 * sets it, in which case neither button is disabled - better to let a tap
 * fail with a toast than grey out a button on a guess. Once known, the
 * button that wouldn't do anything (Pause while already paused, Resume
 * while already playing) is disabled rather than just left clickable and
 * silently doing nothing.
 */
function hostControlsHtml(isPlaying) {
  const statusHtml =
    isPlaying === null ? '' : `<div class="playback-status">${isPlaying ? 'Playing' : 'Paused'}</div>`;

  return `
    ${statusHtml}
    <div class="host-controls">
      <button class="button button-secondary host-action" data-action="pause" ${isPlaying === false ? 'disabled' : ''}>Pause</button>
      <button class="button button-secondary host-action" data-action="resume" ${isPlaying === true ? 'disabled' : ''}>Resume</button>
      <button class="button button-secondary host-action" data-action="skip">Skip</button>
    </div>
  `;
}

/**
 * Swaps the whole page for a terminal screen, keeping the icon sprite
 * alive - it lives in the body, so a plain innerHTML wipe would leave
 * every <use> on the new screen pointing at nothing.
 */
function replaceBody(html) {
  const sprite = document.getElementById('icon-sprite');
  document.body.innerHTML = html;
  if (sprite) document.body.prepend(sprite);
}

/** Replaces the page with a dead end - a bad code, an ended session, or being kicked. */
function renderFatalError(message) {
  replaceBody(`
    <main class="screen screen-center">
      ${logoMarkHtml('logo-mark')}
      <p>${escapeHtml(message)}</p>
      <a class="button button-secondary" href="/">Back home</a>
    </main>
  `);
}

/** The ring-and-bars logo mark. Written out rather than sprited so the terminal screens can't lose it. */
function logoMarkHtml(className) {
  return `
    <svg class="${className}" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" stroke-width="3"/>
      <circle cx="50" cy="50" r="37" fill="none" stroke="currentColor" stroke-width="1"/>
      <rect x="18" y="39" width="8" height="22" rx="2" fill="currentColor"/>
      <rect x="32" y="31" width="8" height="38" rx="2" fill="currentColor"/>
      <rect x="46" y="23" width="8" height="54" rx="2" fill="currentColor"/>
      <rect x="60" y="31" width="8" height="38" rx="2" fill="currentColor"/>
      <rect x="74" y="39" width="8" height="22" rx="2" fill="currentColor"/>
    </svg>
  `;
}

/** The goodbye screen, with the election results when anything actually played. */
function renderSessionEnded(recap) {
  replaceBody(`
    <main class="screen screen-center">
      ${logoMarkHtml('logo-mark')}
      <h1 class="logo">Jukebox Republic</h1>
      <div class="logo-rule"></div>
      <p>The jukebox has stopped. Thanks for listening.</p>
      ${recapHtml(recap)}
      <a class="button button-secondary" href="/">Back home</a>
    </main>
  `);
}

/**
 * The end-of-session "election results" card, built from the recap the
 * server sends with session:ended. Falls back to nothing (rather than an
 * empty card) when the session ended before anything played - the plain
 * goodbye line above carries those.
 */
function recapHtml(recap) {
  if (!recap || !recap.totalPlayed) return '';

  const rows = [];

  if (recap.goldenRecord) {
    const g = recap.goldenRecord;
    rows.push(
      recapRowHtml(
        iconHtml('record'),
        'Golden record',
        `${escapeHtml(g.name)} — ${escapeHtml(g.artist)}`,
        `+${g.netVotes} votes · added by ${escapeHtml(g.addedBy.name)}`
      )
    );
  }
  if (recap.peoplesChampion) {
    const c = recap.peoplesChampion;
    rows.push(
      recapRowHtml(iconHtml('crown'), "The people's champion", escapeHtml(c.name), `+${c.totalNetVotes} net votes across their picks`)
    );
  }
  if (recap.topContributor) {
    const t = recap.topContributor;
    rows.push(
      recapRowHtml(iconHtml('note'), 'Top contributor', escapeHtml(t.name), `${t.played} of the songs that played`)
    );
  }
  if (recap.impeached) {
    const i = recap.impeached;
    rows.push(
      recapRowHtml(iconHtml('impeached'), 'Impeached', escapeHtml(i.name), `${i.votedOut} pick${i.votedOut === 1 ? '' : 's'} voted out by the group`)
    );
  }

  return `
    <div class="card recap-card">
      <h2 class="section-title">Election results</h2>
      ${rows.join('')}
      <div class="recap-footer">${recap.totalPlayed} song${recap.totalPlayed === 1 ? '' : 's'} played · ${recap.guestCount} citizen${recap.guestCount === 1 ? '' : 's'}</div>
    </div>
  `;
}

/** One award row in the results card. */
function recapRowHtml(icon, label, main, sub) {
  return `
    <div class="recap-row">
      <div class="recap-icon">${icon}</div>
      <div class="recap-info">
        <div class="recap-label">${label}</div>
        <div class="recap-main">${main}</div>
        ${sub ? `<div class="recap-sub">${sub}</div>` : ''}
      </div>
    </div>
  `;
}

// --- Interactions ---------------------------------------------------------

/**
 * Wires a tap-vs-hold gesture onto every element matching `selector`, via
 * delegated listeners on `document` so it keeps working across content
 * that gets replaced wholesale on re-render (same reasoning as wireClicks
 * below). A normal click calls `onTap`; holding the pointer down for `ms`
 * instead calls `onHold` and suppresses the click that follows it, so a
 * long press never also triggers the tap action.
 *
 * pointerdown/up rather than mousedown/touchstart+mouseup: one pair covers
 * mouse, touch, and pen without duplicating the timer logic per input type.
 */
function bindLongPress(selector, { onTap, onHold, ms, pressingClass }) {
  let timer = null;
  let fired = false;

  document.addEventListener('pointerdown', (event) => {
    const el = event.target.closest(selector);
    if (!el) return;
    fired = false;
    el.classList.add(pressingClass);
    timer = setTimeout(() => {
      fired = true;
      el.classList.remove(pressingClass);
      onHold(el);
    }, ms);
  });

  // Releasing early (a normal tap) or dragging off the element both cancel
  // the pending hold - only an uninterrupted press should ever reach it.
  const cancelHold = (event) => {
    // pointerleave fires on the whole document when the pointer exits the
    // window, not just an element - event.target is the Document itself
    // then, which has no closest(). Only Elements do.
    if (event.target instanceof Element) {
      event.target.closest(selector)?.classList.remove(pressingClass);
    }
    clearTimeout(timer);
  };
  document.addEventListener('pointerup', cancelHold);
  document.addEventListener('pointerleave', cancelHold, true);
  document.addEventListener('pointercancel', cancelHold);

  // Phones treat a held-down touch as "show the context menu" by default,
  // which would pop up over the hold action. Suppress it only here.
  document.addEventListener('contextmenu', (event) => {
    if (event.target.closest(selector)) event.preventDefault();
  });

  document.addEventListener('click', (event) => {
    const el = event.target.closest(selector);
    if (!el) return;
    // The hold above already handled this press - don't also run the tap
    // action for the click event that follows it.
    if (fired) {
      fired = false;
      return;
    }
    onTap(el);
  });
}

/** Routes every button tap in the app to its socket event. */
function wireClicks(socket) {
  // A tap on a guest chip's action button marks them as gone-for-now
  // (reversible, no ban); holding it down escalates to the permanent,
  // banning kick. Both live on the same button so there's only one
  // control to find on a crowded chip row.
  bindLongPress('.kick-button', {
    ms: 550,
    pressingClass: 'kick-button-pressing',
    onTap: (kickButton) => {
      if (!confirm(`Mark ${kickButton.dataset.guestName} as left? They can rejoin anytime if they come back.`)) return;
      socket.emit('guest:remove', { guestId: kickButton.dataset.guestId }, ackToast);
    },
    onHold: (kickButton) => {
      if (confirm(`Remove ${kickButton.dataset.guestName} from the session? They won't be able to rejoin.`)) {
        socket.emit('guest:kick', { guestId: kickButton.dataset.guestId }, ackToast);
      }
    },
  });

  // Delegated listener on the whole document: now-playing, queue-list, and
  // the read-only lists all get replaced wholesale on every state update,
  // so binding directly to buttons would mean re-binding after every
  // render. One listener up top avoids that entirely.
  document.addEventListener('click', (event) => {
    const voteButton = event.target.closest('.vote-button');
    if (voteButton) {
      const itemId = voteButton.closest('[data-item-id]')?.dataset.itemId;
      const direction = voteButton.dataset.vote;
      if (!itemId || !direction) return;
      socket.emit('queue:vote', { itemId, direction }, ackToast);
      return;
    }

    const hostButton = event.target.closest('.host-action');
    if (hostButton) {
      socket.emit(`playback:${hostButton.dataset.action}`, {}, ackToast);
      return;
    }

    // The queue-mode Switch button carries the mode to switch TO, so the
    // click handler doesn't need to know what's currently active.
    const modeToggle = event.target.closest('.mode-toggle');
    if (modeToggle) {
      socket.emit('queue:mode', { mode: modeToggle.dataset.mode }, ackToast);
      return;
    }

    // Same trick as the mode toggle: the button carries the state to set,
    // not the current one.
    const promoteButton = event.target.closest('.promote-button');
    if (promoteButton) {
      socket.emit(
        'cohost:set',
        { guestId: promoteButton.dataset.guestId, promote: promoteButton.dataset.promote === 'true' },
        ackToast
      );
      return;
    }

    const unbanButton = event.target.closest('.unban-button');
    if (unbanButton) {
      socket.emit('guest:unban', { guestId: unbanButton.dataset.guestId }, ackToast);
      return;
    }

    const readdButton = event.target.closest('.readd-button');
    if (readdButton) {
      const track = readdCaches[readdButton.dataset.list]?.[Number(readdButton.dataset.index)];
      if (!track) return;
      // Re-adding is just adding again - same event, same duplicate check,
      // same fair-rotation round assignment, just sourced from a read-only
      // list instead of a fresh search.
      socket.emit('queue:add', { track }, ackToast);
      return;
    }

    // "Take my own song out of the queue" - only ever rendered on a track
    // this guest added, so no ownership check needed client-side; the
    // server checks it anyway.
    const removeButton = event.target.closest('.remove-button');
    if (removeButton) {
      const itemId = removeButton.closest('[data-item-id]')?.dataset.itemId;
      if (!itemId) return;
      socket.emit('queue:remove', { itemId }, ackToast);
    }
  });
}

/** Bottom tab nav: swaps which .tab-panel is visible and highlights the active button. Pure UI state, no server round-trip. */
function wireTabs() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;

  tabBar.addEventListener('click', (event) => {
    const button = event.target.closest('.tab-button');
    if (!button) return;

    const target = button.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${target}`);
    });
    document.querySelectorAll('.tab-button').forEach((btn) => {
      btn.classList.toggle('active', btn === button);
    });
  });
}

/** The song search box, debounced so a Spotify call doesn't fire per keystroke. */
function wireSearch(sessionId, socket) {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  wireDebouncedInput(input, results, SEARCH_DEBOUNCE_MS, (query) => runSearch(sessionId, query, results, socket));
}

/**
 * Wires an "as you type" input to a debounced query function, clearing
 * the results element - and any pending call - the moment the box goes
 * empty (the shared shape both the song search and playlist search boxes
 * used to hand-roll separately). `onImmediate`, if given, runs
 * synchronously on every non-empty keystroke before the debounce timer
 * starts; the playlist box uses it to short-circuit a pasted link
 * straight to a result, skipping the debounce and the network round-trip
 * entirely when it returns true.
 */
function wireDebouncedInput(input, resultsEl, ms, onQuery, onImmediate) {
  let handle;
  input.addEventListener('input', () => {
    clearTimeout(handle);
    const query = input.value.trim();
    if (!query) {
      resultsEl.innerHTML = '';
      return;
    }
    if (onImmediate && onImmediate(query)) return;
    handle = setTimeout(() => onQuery(query), ms);
  });
}

/** Runs a track search and renders tappable results above the search bar. */
async function runSearch(sessionId, query, resultsEl, socket) {
  const response = await fetch(`/api/sessions/${sessionId}/search?q=${encodeURIComponent(query)}`);
  const data = await response.json();
  if (!data.results) return;

  resultsEl.innerHTML = data.results
    .map(
      (track, index) => `
        <div class="search-result" data-index="${index}">
          <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(track.name)}${explicitBadgeHtml(track)}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
          </div>
          <button class="add-button" data-index="${index}">+</button>
        </div>
      `
    )
    .join('');

  resultsEl.querySelectorAll('.add-button').forEach((button) => {
    button.addEventListener('click', () => {
      const track = data.results[Number(button.dataset.index)];
      socket.emit('queue:add', { track }, ackToast);
      resultsEl.innerHTML = '';
      document.getElementById('search-input').value = '';
    });
  });
}

// --- Autopilot Mix playlist search (host only) -----------------------------

/**
 * The Autopilot tab's "add a playlist" box. Only host.html has the
 * elements (guests browse the mix, the host curates it), so on the guest
 * page this wires nothing. Typing searches Spotify's playlists; pasting a
 * playlist link or spotify:playlist: uri short-circuits search and offers
 * to add exactly that playlist - covering anything search can't surface.
 */
function wirePlaylistSearch(sessionId, socket) {
  const input = document.getElementById('playlist-search-input');
  const results = document.getElementById('playlist-results');
  if (!input || !results) return;

  wireDebouncedInput(
    input,
    results,
    SEARCH_DEBOUNCE_MS,
    (query) => runPlaylistSearch(sessionId, query, results, input, socket),
    (query) => {
      const linkMatch = query.match(/playlist[/:]([A-Za-z0-9]{10,})/);
      if (!linkMatch) return false;
      renderPlaylistResults(results, input, [{ id: linkMatch[1], name: 'Playlist from your link', owner: 'tap + to add it', trackCount: null, image: null }], socket);
      return true;
    }
  );
}

/** Searches Spotify's playlists for the host's Autopilot Mix box. */
async function runPlaylistSearch(sessionId, query, resultsEl, inputEl, socket) {
  const response = await fetch(`/api/sessions/${sessionId}/playlist-search?q=${encodeURIComponent(query)}`);
  const data = await response.json();
  if (!data.results) return;
  renderPlaylistResults(resultsEl, inputEl, data.results, socket);
}

/** Playlist rows with an add button that folds the whole playlist into the mix. */
function renderPlaylistResults(resultsEl, inputEl, playlists, socket) {
  if (playlists.length === 0) {
    resultsEl.innerHTML = '<p class="empty-state">No playlists found.</p>';
    return;
  }

  resultsEl.innerHTML = playlists
    .map(
      (playlist, index) => `
        <div class="search-result">
          <div class="art" style="background-image: url('${playlist.image || ''}')"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(playlist.name)}</div>
            <div class="track-artist">${escapeHtml(playlist.owner)}${playlist.trackCount != null ? ` &middot; ${playlist.trackCount} tracks` : ''}</div>
          </div>
          <button class="add-button" data-index="${index}">+</button>
        </div>
      `
    )
    .join('');

  resultsEl.querySelectorAll('.add-button').forEach((button) => {
    button.addEventListener('click', () => {
      const playlist = playlists[Number(button.dataset.index)];
      // A big playlist takes a moment to page through server-side - lock
      // the button so an impatient double-tap doesn't double-add.
      button.disabled = true;
      socket.emit('autopilot:addPlaylist', { playlistId: playlist.id }, (response) => {
        if (response?.error) {
          showToast(response.error);
          button.disabled = false;
          return;
        }
        showToast(`Added ${response.added} song${response.added === 1 ? '' : 's'} to the Autopilot Mix.`);
        resultsEl.innerHTML = '';
        inputEl.value = '';
      });
    });
  });
}

// --- Small helpers ---------------------------------------------------------

/**
 * The shape every simple emit-with-ack call site in this app shares:
 * do nothing on success, toast the message on failure. Pass directly as
 * a socket.emit ack callback. Exported so host.js can reuse it for its
 * own controls (the volume slider).
 */
export function ackToast(response) {
  if (response?.error) showToast(response.error);
}

/**
 * Wires a button to hand off a join link: the native share sheet first
 * (one tap at a party - lets someone drop it straight into a group chat),
 * clipboard next, and a toast with the raw link as a last resort for
 * browsers with neither. Shared between host.js (the host's own invite
 * button) and guest.js (a guest recruiting more people) since the
 * behavior is identical either way.
 */
export function wireInviteButton(button, joinUrl, roomCode) {
  if (!button) return;

  button.addEventListener('click', async () => {
    const share = { title: 'Jukebox Republic', text: `Join the queue - code ${roomCode}`, url: joinUrl };

    if (navigator.share) {
      // A cancelled share sheet rejects; that's a normal choice, not an error.
      try {
        await navigator.share(share);
        return;
      } catch {
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(joinUrl);
      showToast('Join link copied.');
    } catch {
      showToast(joinUrl);
    }
  });
}

let toastTimer;
/** Brief, non-blocking error message (duplicate song, self-downvote, host-only action, etc). Exported so host.js can reuse it for its own controls. */
export function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

/** Escapes text before it goes into innerHTML - track and guest names reach the DOM this way. Exported since guest.js needs it too. */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
