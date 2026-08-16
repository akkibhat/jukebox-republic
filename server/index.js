// Entry point: wires together the Express app (static frontend + HTTP
// routes), the Socket.io server (real-time queue/voting), and starts
// listening. Nothing else should need to import this file.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { registerSocketHandlers } from './sockets.js';
import { restoreSessions } from './persistence.js';
import { restoreSessionIntoStore } from './sessionStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
// CORS is needed here because the client connects directly to this origin
// rather than through Firebase Hosting's rewrite - Firebase Hosting's CDN
// layer in front of Cloud Run doesn't proxy WebSocket upgrade requests, so
// going through it would silently downgrade every connection to
// long-polling (a real HTTP round-trip per vote/queue action instead of a
// message over an already-open socket). Connecting straight to Cloud Run
// gets native WebSockets; static pages/CSS/JS still load fast from
// Firebase's CDN since only the socket bypasses it.
const io = new Server(httpServer, {
  cors: {
    origin: [config.publicBaseUrl, 'http://localhost:8080'],
    methods: ['GET', 'POST'],
  },
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/auth', authRouter);
app.use('/api', apiRouter);

registerSocketHandlers(io);

// Bring back any sessions that survived the last shutdown (no-op unless
// Firestore persistence is configured - see persistence.js). Done before
// listen so a rejoining phone can't race the restore.
const restored = await restoreSessions();
for (const session of restored) restoreSessionIntoStore(session);
if (restored.length > 0) {
  console.log(`[persistence] restored ${restored.length} session(s): ${restored.map((s) => s.roomCode).join(', ')}`);
}

httpServer.listen(config.port, () => {
  console.log(`Jukebox Republic listening on ${config.publicBaseUrl} (port ${config.port})`);
});
