FROM oven/bun:1.4.3
WORKDIR /app
# The repository's workspace layout: the root manifest and lockfile, every workspace manifest
# (the lockfile names them all), then only the AI and the shared package it imports installed.
COPY package.json bun.lock ./
COPY packages/ ./packages/
RUN bun install --production --frozen-lockfile --filter @gemwright/ai
ENV NODE_ENV=production
ENV AI_DATA=/app/data
USER root
RUN chmod +x /app/packages/ai/start.sh
CMD ["/app/packages/ai/start.sh"]
