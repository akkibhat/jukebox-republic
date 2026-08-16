// Centralizes environment configuration so the rest of the app never touches
// process.env directly. Loading .env here (once, at import time) means every
// other module just does `import { config } from './config.js'`.
import dotenv from 'dotenv';

dotenv.config();

/** Reads an env var, failing fast at startup rather than mid-session if it's missing. */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`,

  spotify: {
    clientId: required('SPOTIFY_CLIENT_ID'),
    clientSecret: required('SPOTIFY_CLIENT_SECRET'),
    redirectUri: required('SPOTIFY_REDIRECT_URI'),
    // Scopes needed to read what's playing, control playback on the host's
    // device (the phone plugged into Android Auto), see the active device,
    // and read the Autopilot Mix seed playlists (private/collaborative -
    // see autopilotMix.js) - without the last two, Spotify 403s on every
    // playlist tracks fetch even for playlists the host owns.
    scopes: [
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-read-collaborative',
    ].join(' '),
  },
};
