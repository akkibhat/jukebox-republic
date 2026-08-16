FROM node:22-slim

WORKDIR /app

# Copy manifests first so the dependency layer is cached across builds that
# only change application code.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

# Cloud Run injects its own PORT - config.js already reads it via
# process.env.PORT, so no override is needed here.
EXPOSE 8080

CMD ["node", "server/index.js"]
