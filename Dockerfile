# Dashboard-/API-Demo ohne Chromium-Player. Baut die Anwendung im Container,
# das Laufzeit-Image enthält nur die gebauten Dateien ohne node_modules.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm test && rm -rf dist/tests

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    SCREENABLE_STATE_DIR=/data SCREENABLE_RUN_DIR=/runtime \
    SCREENABLE_HOST=0.0.0.0 SCREENABLE_PORT=8080 SCREENABLE_ALLOW_HTTP=1
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist
COPY --from=build /src/web/dist ./web/dist
RUN mkdir /data /runtime && chown node:node /data /runtime
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/api.js"]
