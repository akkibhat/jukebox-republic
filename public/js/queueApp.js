// Shared logic between host.html and guest.html - once a sessionId is known
// (the host gets it from its own URL, a guest resolves it from a room
// code), the experience is identical: see what's playing, see the fair
// queue, search Spotify, add songs, vote. Both pages call startQueueApp()
// once they know which session to join.
import { getOrCreateGuestId, getStoredName, setStoredName } from './identity.js';

const SEARCH_DEBOUNCE_MS = 300;

export function startQueueApp(sessionId) {
  const guestId = getOrCreateGuestId();

  ensureName().then((name) => {
    const socket = io(); // same-origin, default path - server serves the client script itself

    socket.on('connect', () => {
      socket.emit('join', { sessionId, guestId, name }, (response) => {
        if (response?.error) {
          renderFatalError(response.error);
        }
      });
    });

    socket.on('state', renderState);

    wireSearch(sessionId, socket);
    wireNowPlayingAndQueueClicks(socket);
  });
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

  renderNowPlaying(state.nowPlaying);
  renderQueue(state.queue);
}

function renderNowPlaying(track) {
  const container = document.getElementById('now-playing');
  if (!container) return;

  if (!track) {
    container.innerHTML = `<p class="empty-state">Nothing playing yet - add a song to get the trip started.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="now-playing" data-item-id="${track.id}">
      <div class="art" style="background-image: url('${track.albumArt || ''}')"></div>
      <div class="track-info">
        <div class="track-name">${escapeHtml(track.name)}</div>
        <div class="track-artist">${escapeHtml(track.artist)}</div>
        <div class="added-by">Added by ${escapeHtml(track.addedBy.name)}</div>
      </div>
      ${voteButtonsHtml(track)}
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
          </div>
          ${voteButtonsHtml(track)}
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

function renderFatalError(message) {
  document.body.innerHTML = `<main class="screen screen-center"><p>${escapeHtml(message)}</p><a class="button button-secondary" href="/">Back home</a></main>`;
}

// --- Interactions ---------------------------------------------------------

function wireNowPlayingAndQueueClicks(socket) {
  // Delegated listener on the whole document: now-playing and queue-list
  // both get replaced wholesale on every state update, so binding directly
  // to buttons would mean re-binding after every render. One listener up
  // top avoids that entirely.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.vote-button');
    if (!button) return;

    const itemId = button.closest('[data-item-id]')?.dataset.itemId;
    const direction = button.dataset.vote;
    if (!itemId || !direction) return;

    socket.emit('queue:vote', { itemId, direction });
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
      socket.emit('queue:add', { track });
      resultsEl.innerHTML = '';
      document.getElementById('search-input').value = '';
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
