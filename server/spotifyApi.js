// Thin wrapper around the bits of the Spotify Web API cartunes actually
// needs: searching the catalog and driving playback on the host's device.
// Every function takes an accessToken rather than a session, so this module
// stays decoupled from how sessions/tokens are managed.

const API_BASE = 'https://api.spotify.com/v1';

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
    throw new Error(`Spotify API ${path} failed: ${response.status} ${body}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function toTrackSummary(track) {
  return {
    uri: track.uri,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(', '),
    albumArt: track.album?.images?.[2]?.url || track.album?.images?.[0]?.url || null,
    durationMs: track.duration_ms,
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

/** Starts playback of a specific track URI on the host's currently active device (their phone). */
export async function playTrack(accessToken, uri, deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  await spotifyFetch(`/me/player/play${query}`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri] }),
  });
}

export async function pausePlayback(accessToken) {
  await spotifyFetch('/me/player/pause', accessToken, { method: 'PUT' });
}

export async function resumePlayback(accessToken) {
  await spotifyFetch('/me/player/play', accessToken, { method: 'PUT' });
}
