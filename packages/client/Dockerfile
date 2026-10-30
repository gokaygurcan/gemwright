FROM oven/bun:1.4.3
WORKDIR /app
COPY bundle/ ./
ENV NODE_ENV=production
ENV CLIENT_BUNDLE_PATH=/app/public
ENV GAMEFILES_PATH=/app/data/gamefiles
EXPOSE 3000
USER bun
CMD ["bun", "server.js"]
