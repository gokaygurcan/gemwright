FROM oven/bun:1.4.3 AS build
WORKDIR /client
COPY build.ts files.ts huffman.ts server.ts ./
COPY web/ ./web/
COPY runtime/ ./runtime/
RUN bun build.ts

FROM oven/bun:1.4.3
WORKDIR /app
COPY --from=build /client/bundle/ ./
ENV NODE_ENV=production
ENV CLIENT_BUNDLE_PATH=/app/public
ENV GAMEFILES_PATH=/app/data/gamefiles
EXPOSE 3000
USER bun
CMD ["bun", "server.js"]
