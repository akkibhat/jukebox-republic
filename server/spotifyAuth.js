// Standard Spotify Authorization Code flow for the host only. Guests never
// authenticate with Spotify at all - they search and vote through the host's
// token, proxied by our server. This is what lets a car full of friends
// join a session without every one of them needing a Spotify account.
import { config } from './config.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotify.clientId,
    scope: config.spotify.scopes,
    redirect_uri: config.spotify.redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuthHeader() {
  const creds = `${config.spotify.clientId}:${config.spotify.clientSecret}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

/** Exchanges the one-time authorization code (from the callback redirect) for real tokens. */
export async function exchangeCodeForTokens(code) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.spotify.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return toTokenRecord(data);
}

/** Access tokens expire after an hour; this trades the long-lived refresh token for a new one. */
export async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token refresh failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  // Spotify doesn't always return a new refresh_token on refresh - keep the old one if so.
  return toTokenRecord({ ...data, refresh_token: data.refresh_token || refreshToken });
}

function toTokenRecord(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Shave 60s off so we refresh a little before Spotify actually cuts us off.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

/** Returns a valid access token for the session's host, refreshing it first if it's about to expire. */
export async function ensureFreshToken(session) {
  if (Date.now() < session.tokens.expiresAt) {
    return session.tokens.accessToken;
  }
  const refreshed = await refreshAccessToken(session.tokens.refreshToken);
  session.tokens = refreshed;
  return refreshed.accessToken;
}
