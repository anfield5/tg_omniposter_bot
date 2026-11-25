# Build context: repository root (see docker-compose.yml)
FROM node:22-bookworm AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production DB_PATH=/data/bot.sqlite
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY core ./core
COPY server/package.json ./server/
COPY server/src ./server/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
CMD ["node", "server/src/index.js"]
