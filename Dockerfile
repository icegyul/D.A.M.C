FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# git backs the optional GitHub backup adapter (POST /v1/backup/github), which
# shells out to `git clone/commit/push`. Without it that endpoint could only ever
# fail, and the export-to-disk paths are unaffected either way.
RUN apk add --no-cache git
# cloudflared powers the built-in Remote Access quick tunnel (Sync Center →
# Remote Access → Enable). It sits idle until the operator turns that on, so
# loopback-only installs are unaffected by its presence.
ARG CLOUDFLARED_VERSION=2026.8.2
RUN wget -qO /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
  && chmod +x /usr/local/bin/cloudflared \
  && cloudflared --version
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web ./web
COPY migrations ./migrations
COPY docs ./docs
COPY integrations ./integrations
COPY .env.example ./.env.example
EXPOSE 8787
CMD ["node","dist/src/server.js"]
