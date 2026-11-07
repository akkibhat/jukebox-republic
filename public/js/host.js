import { startQueueApp, ackToast, escapeHtml, showToast, wireInviteButton } from './queueApp.js?v=0.4.1';
import { fetchJson } from './api.js?v=0.4.1';

/**
 * Draws the app's mark over the center of the #qr-code image once both it
 * and favicon.svg have loaded, replacing the plain code with a branded
 * one. Safe to overlay because the server generates the code with High
 * error correction (see routes/auth.js), which tolerates ~30% of the code
 * being obscured - the logo here is kept well under that. Purely cosmetic:
 * any failure (a blocked/slow image load) just leaves the plain QR code in
 * place rather than breaking anything else on the page.
 */
function embedLogoInQrCode() {
  const qrImg = document.getElementById('qr-code');
  if (!qrImg) return;

  const qr = new Image();
  const logo = new Image();
  let loadedCount = 0;

  const onBothLoaded = () => {
    loadedCount += 1;
    if (loadedCount < 2) return;

    const canvas = document.createElement('canvas');
    canvas.width = qr.naturalWidth;
    canvas.height = qr.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(qr, 0, 0);

    const logoSize = canvas.width * 0.22;
    const x = (canvas.width - logoSize) / 2;
    const y = (canvas.height - logoSize) / 2;
    const pad = logoSize * 0.12;

    // A white halo separates the logo's own dark background from
    // whichever QR modules happen to sit right behind it.
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2);
    ctx.drawImage(logo, x, y, logoSize, logoSize);

    qrImg.src = canvas.toDataURL('image/png');
  };

  qr.onload = onBothLoaded;
  logo.onload = onBothLoaded;
  qr.src = qrImg.src;
  logo.src = '/favicon.svg';
}

/**
 * Saves the session's play history as a private Spotify playlist and opens
 * it in a new tab on success - the toast alone wouldn't be clickable, and a
 * host who just asked for this wants to actually see the result, not just
 * a confirmation that something happened.
 *
 * `button`, when given, is disabled with a "Saving…" label for the
 * duration of the request - a long history can take a couple of seconds to
 * write, and with no feedback in that gap it reads as broken rather than
 * working. The "Stop spinning" flow has no button to disable at that
 * point (the confirm dialogs already own the moment), so it gets an
 * immediate toast instead - same idea, different surface.
 */
function exportHistory(socket, { button, onDone } = {}) {
  if (button) {
    button.disabled = true;
    button.dataset.originalLabel = button.textContent;
    button.textContent = 'Saving…';
  } else {
    showToast('Saving history…');
  }

  socket.emit('history:export', {}, (response) => {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalLabel;
    }
    if (response?.error) {
      showToast(response.error);
    } else {
      showToast('Saved to Spotify - opening playlist…');
      window.open(response.url, '_blank');
    }
    onDone?.();
  });
}

const sessionId = new URLSearchParams(window.location.search).get('session');

/**
 * The host token arrives once, in the URL fragment after the Spotify login
 * (#host=...). Save it per session so a reload still works, then strip it
 * from the address bar so it isn't shared by accident with a screenshot or a
 * copied link. Returns the saved token, or null if this browser never had one.
 */
function takeHostToken(id) {
  if (!id) return null;
  const key = `jr:hostToken:${id}`;
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('host');
  try {
    if (fromHash) localStorage.setItem(key, fromHash);
  } catch {
    // Private mode or blocked storage: fall back to the token in hand.
  }
  if (fromHash) history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    return localStorage.getItem(key) || fromHash;
  } catch {
    return fromHash;
  }
}
const hostToken = takeHostToken(sessionId);

if (!sessionId) {
  document.getElementById('session-header').innerHTML =
    '<p>No session found. <a href="/auth/login">Start one</a>.</p>';
} else {
  fetchJson(`/api/sessions/${sessionId}`)
    .then((info) => {
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">${info.connectedGuestCount} connected</div>
        <div class="guest-names" id="guest-names"></div>
        <div class="banned-guests" id="banned-guests"></div>
        <div class="room-code">${info.roomCode}</div>
        <div class="invite-row">
          <button class="button button-secondary invite-button" id="invite-button" type="button">Share invite link</button>
        </div>
        <p>Or go to <strong>${new URL(info.joinUrl).host}</strong> and enter the code.</p>
        <img id="qr-code" src="${info.qrCodeDataUrl}" alt="QR code to join the spin" />
        <div class="volume-row" id="volume-row">
          <div class="volume-controls" id="volume-controls">
            <svg class="icon volume-icon"><use href="#icon-volume-low"/></svg>
            <input type="range" id="volume-slider" min="0" max="100" value="50" aria-label="Volume" />
            <svg class="icon volume-icon"><use href="#icon-volume-high"/></svg>
          </div>
          <button class="button-icon device-picker-button" id="device-picker-button" type="button" title="Choose playback device">
            <svg class="icon"><use href="#icon-device"/></svg>
          </button>
        </div>
        <div class="device-list" id="device-list" style="display: none;"></div>
        <button class="button button-secondary end-session-button" id="end-session-button" type="button">Stop spinning</button>
      `;
      document.getElementById('ticker-room').textContent = `Room ${info.roomCode}`;
      embedLogoInQrCode();
      wireInviteButton(document.getElementById('invite-button'), info.joinUrl, info.roomCode);
      if (!hostToken) {
        // An old bookmark or a different browser: the server will treat this
        // phone as a guest, so say how to get control back.
        showToast('To control this session, log in with Spotify again on this device.');
      }
      return startQueueApp(sessionId, { isHost: true, hostToken });
    })
    .then((socket) => {
      document.getElementById('end-session-button').addEventListener('click', () => {
        if (!confirm("Stop the music for everyone? This can't be undone.")) return;

        if (confirm("Save this session's play history as a Spotify playlist?")) {
          // Export first, while the session (and its socket) is still
          // alive - the moment session:end lands, the server tears the
          // session down and force-disconnects every socket, which would
          // leave nothing for a save attempted afterward to act on.
          exportHistory(socket, { onDone: () => socket.emit('session:end') });
        } else {
          socket.emit('session:end');
        }
      });

      document.getElementById('export-history-button').addEventListener('click', (event) => {
        exportHistory(socket, { button: event.currentTarget });
      });

      // The slider lives here in the session header (rendered once) rather
      // than the now-playing card, which is re-rendered on every state
      // broadcast - a mid-drag re-render would yank the slider out from
      // under your thumb. 'change' fires on release, so dragging around
      // doesn't spam Spotify with a call per pixel.
      document.getElementById('volume-slider').addEventListener('change', (event) => {
        socket.emit('playback:volume', { percent: Number(event.target.value) }, ackToast);
      });

      // Fetched fresh every time the picker opens rather than kept live -
      // the list only matters for the few seconds the host is choosing,
      // and polling it in the background the rest of the time would just
      // be extra Spotify calls for something nobody's looking at.
      const deviceListEl = document.getElementById('device-list');
      document.getElementById('device-picker-button').addEventListener('click', () => {
        const isOpen = deviceListEl.style.display !== 'none';
        if (isOpen) {
          deviceListEl.style.display = 'none';
          return;
        }
        deviceListEl.style.display = 'block';
        deviceListEl.innerHTML = '<p class="device-list-status">Looking for devices…</p>';
        socket.emit('playback:devices', {}, (response) => {
          if (response?.error) {
            deviceListEl.innerHTML = `<p class="device-list-status">${escapeHtml(response.error)}</p>`;
            return;
          }
          if (!response.devices.length) {
            deviceListEl.innerHTML = '<p class="device-list-status">No devices found. Open Spotify on one first.</p>';
            return;
          }
          deviceListEl.innerHTML = response.devices
            .map(
              (d) =>
                `<button class="device-option${d.isActive ? ' device-option-active' : ''}" data-device-id="${escapeHtml(d.id)}" type="button">${escapeHtml(d.name)}</button>`
            )
            .join('');
        });
      });

      deviceListEl.addEventListener('click', (event) => {
        const option = event.target.closest('.device-option');
        if (!option) return;
        socket.emit('playback:setDevice', { deviceId: option.dataset.deviceId }, (response) => {
          ackToast(response);
          if (!response?.error) deviceListEl.style.display = 'none';
        });
      });
    })
    .catch(() => {
      document.getElementById('session-header').innerHTML =
        '<p>The jukebox has stopped. <a href="/auth/login">Start a new one</a>.</p>';
    });
}
