FROM oven/bun:1.4.3 AS build
WORKDIR /build
# The repository's workspace layout: the root manifest and lockfile, every workspace manifest
# (the lockfile names them all), then the client and the shared package it imports.
COPY package.json bun.lock ./
COPY packages/ ./packages/
RUN bun install --frozen-lockfile --filter @gemwright/client
RUN bun packages/client/build.ts

FROM oven/bun:1.4.3
WORKDIR /app
COPY --from=build /build/packages/client/bundle/ ./
ENV NODE_ENV=production
ENV CLIENT_BUNDLE_PATH=/app/public
ENV GAMEFILES_PATH=/app/data/gamefiles
EXPOSE 3000
USER bun
CMD ["bun", "server.js"]
