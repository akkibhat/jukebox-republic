import { startQueueApp, ackToast, escapeHtml } from './queueApp.js';
import { fetchJson } from './api.js';

const sessionId = new URLSearchParams(window.location.search).get('session');

if (!sessionId) {
  document.getElementById('session-header').innerHTML =
    '<p>No session found. <a href="/auth/login">Start one</a>.</p>';
} else {
  fetchJson(`/api/sessions/${sessionId}`)
    .then((info) => {
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">${info.connectedGuestCount} connected</div>
        <div class="guest-names" id="guest-names"></div>
        <div class="room-code">${info.roomCode}</div>
        <p>Have friends scan this or go to <strong>${new URL(info.joinUrl).host}</strong> and enter the code.</p>
        <img src="${info.qrCodeDataUrl}" alt="QR code to join the spin" />
        <div class="volume-row">
          <svg class="icon volume-icon"><use href="#icon-volume-low"/></svg>
          <input type="range" id="volume-slider" min="0" max="100" value="50" aria-label="Volume" />
          <svg class="icon volume-icon"><use href="#icon-volume-high"/></svg>
          <button class="button-icon device-picker-button" id="device-picker-button" type="button" title="Choose playback device">
            <svg class="icon"><use href="#icon-device"/></svg>
          </button>
        </div>
        <div class="device-list" id="device-list" style="display: none;"></div>
        <button class="button button-secondary end-session-button" id="end-session-button" type="button">Stop spinning</button>
      `;
      return startQueueApp(sessionId, { isHost: true });
    })
    .then((socket) => {
      document.getElementById('end-session-button').addEventListener('click', () => {
        if (!confirm("Stop the music for everyone? This can't be undone.")) return;
        socket.emit('session:end');
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
