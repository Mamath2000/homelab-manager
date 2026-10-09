# syntax=docker/dockerfile:1

# Agent binaries for every supported architecture, served by the hub to the install script.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
# The agent has its own version (agent/VERSION), independent of the application's.
RUN version=$(cat VERSION) && for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -buildvcs=false \
        -ldflags "-s -w -X main.version=$version" -o /out/homelab-agent-linux-$arch . ; \
    done && echo "$version" > /out/VERSION

FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# The hub only has pure JS dependencies, so it can be built once on the build platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS hub
WORKDIR /src
COPY hub/package.json hub/package-lock.json ./
RUN npm ci
COPY hub/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIR=/app/web \
    AGENT_BIN_DIR=/app/agent
WORKDIR /app/hub
COPY hub/package.json ./
COPY hub/assets ./assets
COPY --from=hub /src/node_modules ./node_modules
COPY --from=hub /src/dist ./dist
COPY --from=web /src/dist /app/web
COPY --from=agent /out /app/agent
# account recovery: docker compose exec hub hm-admin
RUN printf '#!/bin/sh\nexec node /app/hub/dist/cli.js "$@"\n' > /usr/local/bin/hm-admin && chmod +x /usr/local/bin/hm-admin
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
