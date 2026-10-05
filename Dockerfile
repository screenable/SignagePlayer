FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./package.json
COPY dist ./dist
COPY web/dist ./web/dist
RUN mkdir /data /runtime && chown node:node /data /runtime
USER node
ENV SCREENABLE_STATE_DIR=/data SCREENABLE_RUN_DIR=/runtime SCREENABLE_HOST=0.0.0.0 SCREENABLE_PORT=8080 SCREENABLE_ALLOW_HTTP=1
EXPOSE 8080
CMD ["node", "dist/api.js"]
