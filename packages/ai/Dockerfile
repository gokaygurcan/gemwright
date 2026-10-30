FROM oven/bun:1.4.3
WORKDIR /app
COPY dist/ ./dist/
COPY catalogs/ ./catalogs/
COPY locations/ ./locations/
COPY templates/ ./templates/
COPY world/ ./world/
COPY tuning.json start.sh ./
ENV NODE_ENV=production
ENV AI_DATA=/app/data
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]
