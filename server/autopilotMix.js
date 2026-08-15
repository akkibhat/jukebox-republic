// The Autopilot Mix is what plays when the real queue runs dry - seeded
// once per trip from one of these hardcoded playlists, picked at random.
// If it runs dry mid-trip, cartunes tops up from another one not yet used
// (see nextUnusedSeedPlaylist), so a long drive isn't limited to a single
// playlist's worth of songs.
const SEED_PLAYLISTS = [
  { id: '6DHD12EjGiRV9uSgIcnn4M', label: 'Roadtrip 2000-2026 (skye)' },
  { id: '4Ln4QdN2U71CXHqyx29KVw', label: 'Roadtrip 2000-2026 (Systemic)' },
  { id: '2TQ0pRHI7T41zi0tV155wW', label: 'Car Songs Roadtrip in 2026' },
];

/** Called once per trip, right after login - the pick stays fixed for that trip rather than re-rolling mid-drive. */
export function pickSeedPlaylist() {
  return SEED_PLAYLISTS[Math.floor(Math.random() * SEED_PLAYLISTS.length)];
}

/** The next playlist not already pulled from this trip, or null once every hardcoded one has been used. */
export function nextUnusedSeedPlaylist(usedIds) {
  return SEED_PLAYLISTS.find((p) => !usedIds.includes(p.id)) || null;
}
