// Centralizes environment configuration so the rest of the app never touches
// process.env directly. Loading .env here (once, at import time) means every
// other module just does `import { config } from './config.js'`.
import dotenv from 'dotenv';

dotenv.config();

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
    // device (the phone plugged into Android Auto), and see the active device.
    scopes: [
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
    ].join(' '),
  },
};
