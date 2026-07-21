FROM oven/bun:1-alpine

LABEL org.opencontainers.image.title="WebEye" \
      org.opencontainers.image.description="Simple open-source website monitoring" \
      org.opencontainers.image.source="https://github.com/obhox/webeye" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Obhox"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/monitor.db

RUN mkdir -p /data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "src/index.ts"]
