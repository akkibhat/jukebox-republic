// Caches each Autopilot Mix seed playlist's tracks in Firestore so session
// creation (and mid-session top-ups) don't have to make a live, multi-page
// Spotify fetch every time - these playlists barely change, and the live
// fetch was a felt source of login latency for data that's practically
// identical to what a fresh fetch would return.
//
// Invalidated by app version rather than a wall-clock TTL: a cached entry
// is only trusted if it was fetched under the version currently running, so
// cutting a release (see scripts/release.mjs) is what triggers a refresh,
// not elapsed time. That matches how often this app actually gets touched
// - deploys are the deliberate moments to pick up any playlist changes,
// not an arbitrary calendar timer. Falls back to a live, uncached fetch
// when Firestore isn't configured, same as persistence.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPlaylistTracks } from './spotifyApi.js';
import { getDb } from './persistence.js';

const COLLECTION = 'seedPlaylistCache';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version: appVersion } = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

/**
 * Tracks for one seed playlist - from cache when it matches this release,
 * otherwise a live Spotify fetch that also refreshes the cache for next
 * time (best-effort: a failed cache write doesn't fail the fetch itself,
 * since the session can still start fine without a cache hit).
 */
export async function getSeedPlaylistTracks(accessToken, playlist) {
  const db = getDb();
  if (!db) return getPlaylistTracks(accessToken, playlist.id);

  const ref = db.collection(COLLECTION).doc(playlist.id);
  const snapshot = await ref.get();
  const cached = snapshot.exists ? snapshot.data() : null;

  if (cached && cached.version === appVersion) {
    return cached.tracks;
  }

  const tracks = await getPlaylistTracks(accessToken, playlist.id);
  ref
    .set({ tracks, version: appVersion, fetchedAt: Date.now() })
    .catch((err) => console.error(`[seedPlaylistCache] failed to cache "${playlist.label}":`, err.message));
  return tracks;
}
