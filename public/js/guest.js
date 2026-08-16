import { startQueueApp, showToast, escapeHtml } from './queueApp.js';
import { fetchJson } from './api.js';

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
  fetchJson(`/api/sessions/by-code/${encodeURIComponent(code)}`)
    .then((info) => {
      // Guests get the code too, not just the host: whoever's already in
      // is usually the one reading it out to the rest of the car, and
      // they shouldn't have to borrow the host's phone to do it.
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">joining&hellip;</div>
        <div class="guest-names" id="guest-names"></div>
        <p>Riding with <strong>${escapeHtml(info.hostDisplayName)}</strong></p>
        <div class="invite-row">
          <span class="invite-code-label">Code <b class="invite-code">${escapeHtml(info.roomCode)}</b></span>
          <button class="button button-secondary invite-button" id="invite-button" type="button">Invite</button>
        </div>
      `;
      wireInvite(info.roomCode);
      startQueueApp(info.sessionId);
    })
    .catch(() => {
      document.getElementById('session-header').innerHTML = '<p>No session found with that code.</p>';
      showCodeForm();
    });
}

/**
 * Hands the join link to whatever the phone offers: the native share
 * sheet first (the one-tap path at a party), then the clipboard. Both
 * need a secure context, so if neither is available the link is shown in
 * a toast for reading aloud - the code is on screen regardless.
 *
 * The link is built from the current origin rather than the server's
 * configured base URL: this page loaded from that origin, so it's known
 * to work for whoever's standing next to you.
 */
function wireInvite(roomCode) {
  const button = document.getElementById('invite-button');
  if (!button) return;

  const joinUrl = `${window.location.origin}/guest.html?code=${encodeURIComponent(roomCode)}`;

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
