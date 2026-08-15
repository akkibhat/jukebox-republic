# Jukebox Republic

The people's queue. One person (the driver) hosts a session through
their Spotify account; everyone else in the car joins from their own phone,
searches for songs, and votes on what plays next. Nobody can flood the queue
with their own taste, and the group can vote a bad pick off the road.

## How it works

- **The host** is whoever's phone is plugged into the car (Android Auto,
  aux, whatever) and playing through their Spotify account. They log in once
  with Spotify at the start of the session; that's the only Spotify account
  needed for the whole car.
- **Guests** open a link or scan a QR code shown on the host's screen, type
  in a name, and they're in - no account, no app install, just a phone
  browser.
- Guests search the Spotify catalog and add songs to a shared queue.
- Songs don't play in the order they're added. They play in **fair
  rotation**: everyone's 1st pick plays before anyone's 2nd pick, everyone's
  2nd before anyone's 3rd, and so on. Add five songs in a row and you've
  still only guaranteed yourself one turn before the rest of the car gets a
  turn too.
- Anyone can thumbs-down a song, current or queued. Once more than half the
  connected car agrees (majority rule - one person in a 2-person car, two of
  three, two of four, three of five...), it's skipped/removed. It doesn't
  vanish, though - it lands on a **Skipped songs** list, and anyone can
  re-add it if they change their mind.
- The host always has manual Pause/Resume/Skip controls regardless of what
  the vote says - the group's vote is a way for everyone *else* to weigh in,
  not a way to lock the driver out of their own stereo.

See [`server/queueFairness.js`](server/queueFairness.js) for the actual
rotation and voting logic - it's a small, heavily-commented file and the
real explanation of "why" lives there, not here.

## Why a hosted backend instead of a local hotspot

Earlier attempts at this (see the git history / old repos, since deleted -
they ran a Raspberry Pi as a Mopidy server and had guests join its WiFi
hotspot) fought the car itself: phones can't reliably hotspot, stay
connected to Android Auto, and hold a data connection all at the same time.
This version instead has the host and every guest talk to a small server
over their own cellular data - nobody needs to be on the same network, and
it doesn't care whether the host's phone is also busy mirroring to the
dash.

## Setup

1. Create a Spotify app at the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
   You (as the host) need a **Spotify Premium** account - playback control
   through the Web API doesn't work on Free.
2. In the app's settings, add a Redirect URI. For local testing that's
   `http://127.0.0.1:8080/auth/callback`; for a real deployment use your
   actual domain.
3. Copy `.env.example` to `.env` and fill in the client ID/secret from the
   dashboard, plus `PUBLIC_BASE_URL` (the URL guests will actually load -
   your deployed URL, or `http://127.0.0.1:8080` for local testing on one
   machine).
4. Install and run:

   ```
   npm install
   npm start
   ```

5. The host opens `PUBLIC_BASE_URL` and taps "Start spinning," which sends
   them through Spotify login. Guests open the same URL and enter the session
   code shown on the host's screen (or scan the QR code).

For guests on other phones to actually reach it, the server needs to be
reachable from the open internet (deploy it somewhere, or use a tunnel like
`ngrok` while testing) - `127.0.0.1` only works if everyone's testing on the
same machine.

## Project layout

```
server/
  index.js          Express + Socket.io entry point
  config.js         Environment variable loading
  spotifyAuth.js    OAuth login/token refresh for the host
  spotifyApi.js     Search + playback control calls to the Spotify Web API
  sessionStore.js   In-memory session/guest/queue state
  queueFairness.js  The rotation + voting algorithm (read this one)
  playbackEngine.js Watches playback progress and advances the queue
  sockets.js        Real-time join/add/vote handling
  routes/           HTTP routes (Spotify login, session info, search)
public/
  index.html        Landing page (start a session / join a session)
  host.html          Host's screen: session code, QR, queue
  guest.html         Guest's screen: same queue view, joined by code
  js/                Browser-side logic shared between host and guest pages
```

## Known limitations

- State is in-memory only - restarting the server ends every active session.
  Fine for a single-instance deployment; would need a shared store (Redis
  or similar) to run more than one server instance.
- The playback engine polls Spotify every few seconds rather than reacting
  to a push event, since the Web API doesn't offer one for track-end. This
  means auto-advance has a couple seconds of slack, which is intentional -
  see `END_OF_TRACK_LEAD_MS` in `playbackEngine.js`.
- No persistence of past sessions, favorite songs, or stats. Could be worth
  adding later if there's demand for "what did we listen to last time."
