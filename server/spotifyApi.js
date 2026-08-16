// Thin wrapper around the bits of the Spotify Web API Jukebox Republic actually
// needs: searching the catalog and driving playback on the host's device.
// Every function takes an accessToken rather than a session, so this module
// stays decoupled from how sessions/tokens are managed.

const API_BASE = 'https://api.spotify.com/v1';

/**
 * Every Spotify call goes through here: adds auth, turns non-2xx into
 * errors carrying `.status` (so callers can tell a rejected request from a
 * network failure), and tolerates the empty/non-JSON bodies the playback
 * endpoints sometimes return on success.
 */
async function spotifyFetch(path, accessToken, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return null; // Spotify uses 204 for successful playback commands
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Spotify API ${path} failed: ${response.status} ${body}`);
    // Attached so callers can tell "Spotify explicitly said no to this"
    // (4xx) apart from "Spotify's own servers had a problem" (5xx) or
    // rate-limiting (429) - see classifyPlaybackError in playbackEngine.js.
    // A raw fetch() failure (no network route to Spotify at all) throws
    // before reaching this point and so never gets a .status, which is
    // itself the signal that it was a connectivity problem, not Spotify
    // rejecting the request.
    error.status = response.status;
    throw error;
  }

  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // The playback-control endpoints (pause/play especially) sometimes
    // answer with a 2xx status but a body that isn't valid JSON, even
    // though the command itself went through fine - the status code
    // already told us it succeeded, so there's nothing worth throwing
    // over. This was showing up as "it worked but an error popped up"
    // on the host's Pause/Resume buttons.
    console.warn(`[spotify] ${path} returned a non-JSON success body, ignoring it:`, text.slice(0, 80));
    return null;
  }
}

/** Trims Spotify's track object down to the handful of fields the app actually shows. */
function toTrackSummary(track) {
  return {
    uri: track.uri,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(', '),
    albumArt: track.album?.images?.[2]?.url || track.album?.images?.[0]?.url || null,
    durationMs: track.duration_ms,
    explicit: Boolean(track.explicit),
  };
}

/** The host's own profile - just used once at login to label the session and greet them by name. */
export async function getCurrentUserProfile(accessToken) {
  const data = await spotifyFetch('/me', accessToken);
  return { id: data.id, displayName: data.display_name || data.id };
}

/** Searches the catalog for tracks. Used by guests typing into the "add a song" box. */
export async function searchTracks(accessToken, query, limit = 12) {
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
  const data = await spotifyFetch(`/search?${params.toString()}`, accessToken);
  return data.tracks.items.map(toTrackSummary);
}

/**
 * Searches the catalog for playlists - the host's "add a playlist to the
 * Autopilot Mix" flow. Two Development Mode realities shape this (both
 * verified against the live API while building this app):
 *
 * - Search returns at most 10 results per query in Dev Mode, so there's
 *   no point asking for more.
 * - Spotify's own editorial/algorithmic playlists (ids starting
 *   37i9dQZF1D) 404 when their tracks are fetched, so they're filtered
 *   out here rather than shown as options that can't actually work.
 *   Community/user-made playlists all read fine.
 *
 * Search item arrays can also contain literal nulls (a long-standing API
 * quirk), hence the initial truthiness filter.
 */
export async function searchPlaylists(accessToken, query, limit = 10) {
  const params = new URLSearchParams({ q: query, type: 'playlist', limit: String(limit) });
  const data = await spotifyFetch(`/search?${params.toString()}`, accessToken);
  return (data.playlists?.items || [])
    .filter((playlist) => playlist && !playlist.id.startsWith('37i9dQZF1D'))
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      owner: playlist.owner?.display_name || '',
      trackCount: playlist.tracks?.total ?? null,
      // Last image is the smallest rendition when several exist - plenty
      // for a 56px thumbnail row.
      image: playlist.images?.[playlist.images.length - 1]?.url || playlist.images?.[0]?.url || null,
    }));
}

/**
 * Every track in a public Spotify playlist - used once per session to seed
 * the Autopilot Mix. Spotify caps a single response at 100 tracks, so this
 * pages through using the paging object's `next` link until it runs out
 * (which `next: null` signals). Playlists can contain local files or
 * regionally-unavailable tracks, which come back with a null/non-Spotify
 * uri; those are filtered out since playTrack() can't do anything with
 * them (Spotify's playback API only accepts real spotify:track: uris).
 * MAX_PAGES is just a safety net against an unexpected pagination bug
 * looping forever - real road-trip playlists top out a few hundred tracks,
 * nowhere near the 2,000 that would take.
 */
const PLAYLIST_PAGE_SIZE = 100;
const MAX_PLAYLIST_PAGES = 20;

/** Fetches a playlist's playable tracks, paging until Spotify runs out (see the note above). */
export async function getPlaylistTracks(accessToken, playlistId) {
  const tracks = [];
  let path = `/playlists/${playlistId}/tracks?limit=${PLAYLIST_PAGE_SIZE}&fields=items(track(uri,name,artists,album,duration_ms,explicit)),next`;

  for (let page = 0; path && page < MAX_PLAYLIST_PAGES; page += 1) {
    const data = await spotifyFetch(path, accessToken);
    if (!data) break;

    for (const item of data.items || []) {
      if (item.track?.uri?.startsWith('spotify:track:')) {
        tracks.push(toTrackSummary(item.track));
      }
    }

    // `next` is a fully-qualified URL (https://api.spotify.com/v1/...) -
    // spotifyFetch wants a path relative to API_BASE, so strip that prefix.
    path = data.next ? data.next.replace(API_BASE, '') : null;
  }

  return tracks;
}

/** What's currently playing on the host's account, wherever it's playing. */
export async function getPlaybackState(accessToken) {
  const data = await spotifyFetch('/me/player', accessToken);
  if (!data || !data.item) return null;
  return {
    track: toTrackSummary(data.item),
    isPlaying: data.is_playing,
    progressMs: data.progress_ms,
    deviceId: data.device?.id || null,
    deviceName: data.device?.name || null,
  };
}

/**
 * Every Spotify Connect device this account can currently see (phone,
 * speaker, desktop app...), active or not. This is distinct from the
 * device on getPlaybackState, which is only populated once something is
 * already playing/paused there - useless for starting playback from cold,
 * which is exactly what happens the moment a session's first song is added.
 * A device shows up here as soon as its Spotify app is open, whether or
 * not it's actively playing anything.
 */
export async function getAvailableDevices(accessToken) {
  const data = await spotifyFetch('/me/player/devices', accessToken);
  return (data?.devices || []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
  }));
}

/**
 * Moves playback to a specific Connect device by id. Spotify auto-picks a
 * device (see resolveTargetDevice in playbackEngine.js) whenever nothing is
 * already active, which is what lets a screen-off phone lose out to
 * whatever else the host's account can see (a TV, a speaker) - this is the
 * host's manual override for that. `play: true` would also resume/start
 * playback on the target as part of the same call; left false here since
 * the host is just relocating where an already-running (or about-to-start)
 * session plays, not toggling playback state.
 */
export async function transferPlayback(accessToken, deviceId) {
  await spotifyFetch('/me/player', accessToken, {
    method: 'PUT',
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });
}

/** Starts playback of a specific track URI on the host's currently active device (their phone). */
export async function playTrack(accessToken, uri, deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await spotifyFetch(`/me/player/play${query}`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}

/** Pauses whatever the host's account is playing. */
export async function pausePlayback(accessToken) {
  await spotifyFetch('/me/player/pause', accessToken, { method: 'PUT' });
}

/**
 * Sets playback volume (0-100) on whatever device is currently playing.
 * Not every Connect device supports remote volume - restricted ones
 * (some speakers, TVs) answer 403, which the caller turns into a
 * "this device won't allow it" message rather than a retry.
 */
export async function setVolume(accessToken, volumePercent) {
  await spotifyFetch(`/me/player/volume?volume_percent=${volumePercent}`, accessToken, { method: 'PUT' });
}

/** Resumes playback where it was paused, without changing the track. */
export async function resumePlayback(accessToken) {
  await spotifyFetch('/me/player/play', accessToken, { method: 'PUT' });
}
