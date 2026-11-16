# factory-app: web UI + API. Build context is the repo root.
FROM node:24-alpine AS web
WORKDIR /src/apps/web
COPY apps/web/package*.json ./
RUN npm install --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM node:24-alpine AS server
WORKDIR /src/apps/server
COPY apps/server/package*.json ./
RUN npm install --no-audit --no-fund
COPY apps/server/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production WEB_DIR=/app/web PORT=3000
WORKDIR /app
COPY --from=server /src/apps/server/package.json ./
COPY --from=server /src/apps/server/node_modules ./node_modules
COPY --from=server /src/apps/server/dist ./dist
COPY --from=web /src/apps/web/dist ./web
EXPOSE 3000
CMD ["node", "dist/index.js"]
