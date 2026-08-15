import { startQueueApp } from './queueApp.js';

const sessionId = new URLSearchParams(window.location.search).get('session');

if (!sessionId) {
  document.getElementById('session-header').innerHTML =
    '<p>No session found. <a href="/auth/login">Start one</a>.</p>';
} else {
  fetch(`/api/sessions/${sessionId}`)
    .then((res) => {
      if (!res.ok) throw new Error('not found');
      return res.json();
    })
    .then((info) => {
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">${info.connectedGuestCount} connected</div>
        <div class="guest-names" id="guest-names"></div>
        <div class="room-code">${info.roomCode}</div>
        <p>Have friends scan this or go to <strong>${new URL(info.joinUrl).host}</strong> and enter the code.</p>
        <img src="${info.qrCodeDataUrl}" alt="QR code to join the spin" />
        <button class="button button-secondary end-session-button" id="end-session-button" type="button">Stop spinning</button>
      `;
      return startQueueApp(sessionId, { isHost: true });
    })
    .then((socket) => {
      document.getElementById('end-session-button').addEventListener('click', () => {
        if (!confirm("Stop the music for everyone? This can't be undone.")) return;
        socket.emit('session:end');
      });
    })
    .catch(() => {
      document.getElementById('session-header').innerHTML =
        '<p>The jukebox has stopped. <a href="/auth/login">Start a new one</a>.</p>';
    });
}
