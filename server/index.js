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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/auth', authRouter);
app.use('/api', apiRouter);

registerSocketHandlers(io);

httpServer.listen(config.port, () => {
  console.log(`cartunes listening on ${config.publicBaseUrl} (port ${config.port})`);
});
