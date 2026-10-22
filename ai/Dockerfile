FROM oven/bun:1.4.3
WORKDIR /app
# The AI imports the shared Huffman decoder from client/, so the repository layout is kept.
COPY client/huffman.ts ./client/huffman.ts
COPY ai/package.json ai/bun.lock ai/tsconfig.json ./ai/
RUN cd ai && bun install --production --frozen-lockfile
COPY ai/src/ ./ai/src/
COPY ai/world/ ./ai/world/
COPY ai/templates/ ./ai/templates/
COPY ai/locations/ ./ai/locations/
COPY ai/catalogs/ ./ai/catalogs/
COPY ai/start.sh ./ai/start.sh
ENV NODE_ENV=production
ENV AI_DATA=/app/data
USER root
RUN chmod +x /app/ai/start.sh
CMD ["/app/ai/start.sh"]
