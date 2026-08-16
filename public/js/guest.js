import { startQueueApp } from './queueApp.js';

const codeFromUrl = new URLSearchParams(window.location.search).get('code');

if (codeFromUrl) {
  joinByCode(codeFromUrl);
} else {
  showCodeForm();
}

/** Asks for a session code - shown when someone lands on the guest page without one in the URL. */
function showCodeForm() {
  const header = document.getElementById('session-header');
  header.innerHTML = `
    <form id="code-form" class="card">
      <label for="code-input">Session code</label>
      <input id="code-input" autocomplete="off" autocapitalize="characters" maxlength="8" required />
      <button class="button button-primary" type="submit">Join</button>
    </form>
  `;
  document.getElementById('code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (code) joinByCode(code);
  });
}

/** Resolves a code to a session and starts the shared queue UI, or re-prompts if it's wrong. */
function joinByCode(code) {
  fetch(`/api/sessions/by-code/${encodeURIComponent(code)}`)
    .then((res) => {
      if (!res.ok) throw new Error('not found');
      return res.json();
    })
    .then((info) => {
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">joining&hellip;</div>
        <div class="guest-names" id="guest-names"></div>
        <p>Riding with <strong>${escapeHtml(info.hostDisplayName)}</strong></p>
      `;
      startQueueApp(info.sessionId);
    })
    .catch(() => {
      document.getElementById('session-header').innerHTML = '<p>No session found with that code.</p>';
      showCodeForm();
    });
}

/** Escapes text before it goes into innerHTML - guest-chosen names reach the DOM this way. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
