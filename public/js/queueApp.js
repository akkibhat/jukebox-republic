// Shared logic between host.html and guest.html - once a sessionId is known
// (the host gets it from its own URL, a guest resolves it from a room
// code), the experience is identical except the host also gets playback
// override buttons. Both pages call startQueueApp() once they know which
// session to join.
import { getOrCreateGuestId, getStoredName, setStoredName } from './identity.js';

const SEARCH_DEBOUNCE_MS = 300;

// Set once per page load by startQueueApp - host.html and guest.html each
// load their own instance of this module, so these never leak between them.
let isHostView = false;
let myGuestId = null;

// Caches for the "read-only list with a button that sends it to the main
// queue" sections (Autopilot Mix, skipped songs, play history) - a click
// only carries a list id + index, so this is where the full track objects
// live to look up when that fires. Same trick runSearch uses for its own
// results.
const readdCaches = { 'autopilot-list': [], 'skipped-list': [], 'history-list': [] };

/**
 * Joins the session and wires up the whole real-time UI. Returns a promise
 * that resolves with the connected socket once the join succeeds, so a
 * caller (host.js, for the "End trip" button) can piggyback host-only
 * actions onto the same connection instead of opening a second one.
 */
export function startQueueApp(sessionId, { isHost = false } = {}) {
  isHostView = isHost;
  myGuestId = getOrCreateGuestId();

  return ensureName().then(
    (name) =>
      new Promise((resolve) => {
        const socket = io(); // same-origin, default path - server serves the client script itself

        socket.on('connect', () => {
          socket.emit('join', { sessionId, guestId: myGuestId, name, isHost }, (response) => {
            if (response?.error) {
              renderFatalError(response.error);
              return;
            }
            resolve(socket);
          });
        });

        socket.on('state', renderState);
        socket.on('session:ended', renderTripEnded);

        wireSearch(sessionId, socket);
        wireClicks(socket);
      })
  );
}

// --- Name capture -----------------------------------------------------

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

function renderState(state) {
  const guestCountEl = document.getElementById('guest-count');
  if (guestCountEl) {
    guestCountEl.textContent = `${state.connectedGuestCount} connected`;
  }
  const guestNamesEl = document.getElementById('guest-names');
  if (guestNamesEl) {
    guestNamesEl.textContent = state.guestNames && state.guestNames.length ? state.guestNames.join(', ') : '';
  }

  renderNowPlaying(state.nowPlaying, state.playbackBlockedReason, state.isPlaying);
  renderQueue(state.queue);
  renderReaddableList('autopilot-section', 'autopilot-list', state.fallbackTracks, 'Add to queue');
  renderReaddableList('skipped-section', 'skipped-list', state.skippedSongs);
  renderReaddableList('history-section', 'history-list', state.playHistory);
}

function renderNowPlaying(track, playbackBlockedReason, isPlaying) {
  const container = document.getElementById('now-playing');
  if (!container) return;

  if (!track) {
    container.innerHTML = playbackBlockedReason
      ? `<p class="empty-state empty-state-warning">${escapeHtml(playbackBlockedReason)}</p>`
      : `<p class="empty-state">Nothing playing yet - add a song to get the trip started.</p>`;
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
      ${isHostView ? hostControlsHtml(isPlaying) : ''}
    </div>
  `;
}

function renderQueue(queue) {
  const list = document.getElementById('queue-list');
  if (!list) return;

  if (queue.length === 0) {
    list.innerHTML = `<p class="empty-state">Queue's empty. Search below to add the next song.</p>`;
    return;
  }

  list.innerHTML = queue
    .map(
      (track) => `
        <div class="queue-item" data-item-id="${track.id}">
          <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
          <div class="track-info">
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
}

/**
 * Renders a read-only track list where every row can be sent into the main
 * queue with one tap - used for the Autopilot Mix preview, the skipped-
 * songs list, and play history, all shaped identically on the wire. The
 * whole section hides itself when empty, rather than showing an empty
 * heading with nothing under it.
 */
function renderReaddableList(sectionId, listId, tracks, buttonLabel = 'Re-add') {
  const section = document.getElementById(sectionId);
  const list = document.getElementById(listId);
  if (!section || !list) return;

  readdCaches[listId] = tracks || [];

  if (readdCaches[listId].length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = readdCaches[listId]
    .map(
      (track, index) => `
        <div class="queue-item skipped-item">
          <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(track.name)}${explicitBadgeHtml(track)}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
          </div>
          <button class="button button-secondary readd-button" data-list="${listId}" data-index="${index}">${buttonLabel}</button>
        </div>
      `
    )
    .join('');
}

function voteButtonsHtml(track) {
  const upClass = track.myVote === 'up' ? 'active-up' : '';
  const downClass = track.myVote === 'down' ? 'active-down' : '';
  return `
    <div class="vote-buttons">
      <button class="vote-button ${upClass}" data-vote="up">&#9650;</button>
      <span class="net-votes">${track.netVotes}</span>
      <button class="vote-button ${downClass}" data-vote="down">&#9660;</button>
    </div>
  `;
}

function removeButtonHtml() {
  return `<button class="remove-button" title="Remove your song">&times;</button>`;
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

function renderFatalError(message) {
  document.body.innerHTML = `<main class="screen screen-center"><p>${escapeHtml(message)}</p><a class="button button-secondary" href="/">Back home</a></main>`;
}

function renderTripEnded() {
  document.body.innerHTML = `
    <main class="screen screen-center">
      <h1 class="logo">cartunes</h1>
      <p>This trip has ended. Thanks for riding along.</p>
      <a class="button button-secondary" href="/">Back home</a>
    </main>
  `;
}

// --- Interactions ---------------------------------------------------------

function wireClicks(socket) {
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
      socket.emit('queue:vote', { itemId, direction }, (response) => {
        if (response?.error) showToast(response.error);
      });
      return;
    }

    const hostButton = event.target.closest('.host-action');
    if (hostButton) {
      socket.emit(`playback:${hostButton.dataset.action}`, {}, (response) => {
        if (response?.error) showToast(response.error);
      });
      return;
    }

    const readdButton = event.target.closest('.readd-button');
    if (readdButton) {
      const track = readdCaches[readdButton.dataset.list]?.[Number(readdButton.dataset.index)];
      if (!track) return;
      // Re-adding is just adding again - same event, same duplicate check,
      // same fair-rotation round assignment, just sourced from a read-only
      // list instead of a fresh search.
      socket.emit('queue:add', { track }, (response) => {
        if (response?.error) showToast(response.error);
      });
      return;
    }

    // "Take my own song out of the queue" - only ever rendered on a track
    // this guest added, so no ownership check needed client-side; the
    // server checks it anyway.
    const removeButton = event.target.closest('.remove-button');
    if (removeButton) {
      const itemId = removeButton.closest('[data-item-id]')?.dataset.itemId;
      if (!itemId) return;
      socket.emit('queue:remove', { itemId }, (response) => {
        if (response?.error) showToast(response.error);
      });
    }
  });
}

function wireSearch(sessionId, socket) {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  let debounceHandle;

  input.addEventListener('input', () => {
    clearTimeout(debounceHandle);
    const query = input.value.trim();
    if (!query) {
      results.innerHTML = '';
      return;
    }
    debounceHandle = setTimeout(() => runSearch(sessionId, query, results, socket), SEARCH_DEBOUNCE_MS);
  });
}

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
      socket.emit('queue:add', { track }, (response) => {
        if (response?.error) showToast(response.error);
      });
      resultsEl.innerHTML = '';
      document.getElementById('search-input').value = '';
    });
  });
}

// --- Small helpers ---------------------------------------------------------

let toastTimer;
/** Brief, non-blocking error message (duplicate song, self-downvote, host-only action, etc). */
function showToast(message) {
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
