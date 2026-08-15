import { startQueueApp } from './queueApp.js';

const sessionId = new URLSearchParams(window.location.search).get('session');

if (!sessionId) {
  document.getElementById('session-header').innerHTML =
    '<p>No trip found. <a href="/auth/login">Start one</a>.</p>';
} else {
  fetch(`/api/sessions/${sessionId}`)
    .then((res) => {
      if (!res.ok) throw new Error('not found');
      return res.json();
    })
    .then((info) => {
      document.getElementById('session-header').innerHTML = `
        <div class="guest-count" id="guest-count">${info.connectedGuestCount} connected</div>
        <div class="room-code">${info.roomCode}</div>
        <p>Have friends scan this or go to <strong>${new URL(info.joinUrl).host}</strong> and enter the code.</p>
        <img src="${info.qrCodeDataUrl}" alt="QR code to join the trip" />
      `;
      startQueueApp(sessionId);
    })
    .catch(() => {
      document.getElementById('session-header').innerHTML =
        '<p>This trip has ended. <a href="/auth/login">Start a new one</a>.</p>';
    });
}
