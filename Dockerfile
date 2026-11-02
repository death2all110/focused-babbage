# syntax=docker/dockerfile:1
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY src ./src
COPY public ./public
COPY icon.png ./

RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node dist/server/server/index.js"]
