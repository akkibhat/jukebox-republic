// The Autopilot Mix is what plays when the real queue runs dry - seeded
// once per trip from one of these two playlists, picked at random.
const SEED_PLAYLISTS = [
  { id: '37i9dQZF1DWSY3qrD2Jh0k', label: 'Road Trip (Spotify)' },
  { id: '6DHD12EjGiRV9uSgIcnn4M', label: 'Roadtrip 2000-2026 - Best driving songs' },
];

/** Called once per trip, right after login - the pick stays fixed for that trip rather than re-rolling mid-drive. */
export function pickSeedPlaylist() {
  return SEED_PLAYLISTS[Math.floor(Math.random() * SEED_PLAYLISTS.length)];
}

/** The playlist NOT already used this trip - called once the first one runs dry, to top up instead of going silent. */
export function otherSeedPlaylist(usedId) {
  return SEED_PLAYLISTS.find((p) => p.id !== usedId) || null;
}
