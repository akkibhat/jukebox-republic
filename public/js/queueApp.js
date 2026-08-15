// Shared logic between host.html and guest.html - once a sessionId is known
// (the host gets it from its own URL, a guest resolves it from a room
// code), the experience is identical except the host also gets playback
// override buttons. Both pages call startQueueApp() once they know which
// session to join.
import { getOrCreateGuestId, getStoredName, setStoredName } from './identity.js';

const SEARCH_DEBOUNCE_MS = 300;

// Set once per page load by startQueueApp - host.html and guest.html each
// load their own instance of this module, so this never leaks between them.
let isHostView = false;

// The last skipped-songs list from the server, kept around so a click on a
// "Re-add" button (which only has a data-index) can look up the full track
// object to send back - same trick runSearch uses for its own result list.
let lastSkippedSongs = [];

/**
 * Joins the session and wires up the whole real-time UI. Returns a promise
 * that resolves with the connected socket once the join succeeds, so a
 * caller (host.js, for the "End trip" button) can piggyback host-only
 * actions onto the same connection instead of opening a second one.
 */
export function startQueueApp(sessionId, { isHost = false } = {}) {
  isHostView = isHost;
  const guestId = getOrCreateGuestId();

  return ensureName().then(
    (name) =>
      new Promise((resolve) => {
        const socket = io(); // same-origin, default path - server serves the client script itself

        socket.on('connect', () => {
          socket.emit('join', { sessionId, guestId, name, isHost }, (response) => {
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

  renderNowPlaying(state.nowPlaying, state.playbackBlockedReason);
  renderQueue(state.queue);
  renderSkippedSongs(state.skippedSongs);
}

function renderNowPlaying(track, playbackBlockedReason) {
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
          <div class="track-name">${escapeHtml(track.name)}</div>
          <div class="track-artist">${escapeHtml(track.artist)}</div>
          <div class="added-by">Added by ${escapeHtml(track.addedBy.name)}</div>
          ${skipProgressHtml(track)}
        </div>
        ${voteButtonsHtml(track)}
      </div>
      ${isHostView ? hostControlsHtml() : ''}
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
            <div class="track-name">${escapeHtml(track.name)}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
            <div class="added-by">${escapeHtml(track.addedBy.name)}</div>
            ${skipProgressHtml(track)}
          </div>
          ${voteButtonsHtml(track)}
        </div>
      `
    )
    .join('');
}

/**
 * Tracks the group voted out, sitting off to the side so a "no" from the
 * car isn't permanent - anyone can send one straight back into the queue.
 * The whole section hides itself when there's nothing skipped yet, rather
 * than showing an empty "Skipped songs" heading with nothing under it.
 */
function renderSkippedSongs(skippedSongs) {
  const section = document.getElementById('skipped-section');
  const list = document.getElementById('skipped-list');
  if (!section || !list) return;

  lastSkippedSongs = skippedSongs || [];

  if (lastSkippedSongs.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  section.style.display = 'block';
  list.innerHTML = lastSkippedSongs
    .map(
      (track, index) => `
        <div class="queue-item skipped-item">
          <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
          <div class="track-info">
            <div class="track-name">${escapeHtml(track.name)}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
          </div>
          <button class="button button-secondary readd-button" data-index="${index}">Re-add</button>
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

/** "2 of 3 to skip" - only shown once a track has at least one downvote, so a clean track shows nothing extra. */
function skipProgressHtml(track) {
  if (!track.downvotes) return '';
  return `<div class="skip-progress">${track.downvotes} of ${track.threshold} downvotes to skip</div>`;
}

function hostControlsHtml() {
  return `
    <div class="host-controls">
      <button class="button button-secondary host-action" data-action="pause">Pause</button>
      <button class="button button-secondary host-action" data-action="resume">Resume</button>
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
  // Delegated listener on the whole document: now-playing and queue-list
  // both get replaced wholesale on every state update, so binding directly
  // to buttons would mean re-binding after every render. One listener up
  // top avoids that entirely, and covers vote buttons and host controls
  // alike since both get re-created the same way.
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
      const track = lastSkippedSongs[Number(readdButton.dataset.index)];
      if (!track) return;
      // Re-adding is just adding again - same event, same duplicate check,
      // same fair-rotation round assignment, just sourced from the skipped
      // list instead of a fresh search.
      socket.emit('queue:add', { track }, (response) => {
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
            <div class="track-name">${escapeHtml(track.name)}</div>
            <div class="track-artist">${escapeHtml(track.artist)}</div>
          </div>
          <button data-index="${index}">+</button>
        </div>
      `
    )
    .join('');

  resultsEl.querySelectorAll('button[data-index]').forEach((button) => {
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
