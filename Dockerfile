# syntax=docker/dockerfile:1

# Agent binaries for every supported architecture, served by the hub to the install script.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
# The agent has its own version (agent/VERSION), independent of the application's.
# Release (RELEASE_PUB = agent/release.pub): each binary is signed with the release key, a BuildKit
# secret that never ends up in the image, and embeds the public key, so the agents refuse unsigned
# updates. RELEASE_PUB is also part of the cache key: an unsigned layer is never reused for a release.
# Without it (local docker build): unsigned development agents.
ARG RELEASE_PUB=""
RUN --mount=type=secret,id=release_key \
    version=$(cat VERSION) && \
    if [ -n "$RELEASE_PUB" ]; then \
      [ -s /run/secrets/release_key ] || { echo "RELEASE_PUB set but no release_key secret" >&2; exit 1; }; \
      CGO_ENABLED=0 go build -o /usr/local/bin/hm-sign ./cmd/hm-sign && \
      [ "$(hm-sign pub -key /run/secrets/release_key)" = "$RELEASE_PUB" ] || { echo "release key does not match agent/release.pub" >&2; exit 1; }; \
    else echo "warning: unsigned development agents (no RELEASE_PUB)" >&2; fi && \
    for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -buildvcs=false \
        -ldflags "-s -w -X main.version=$version -X main.releasePubKey=$RELEASE_PUB" -o /out/homelab-agent-linux-$arch . ; \
    done && \
    if [ -n "$RELEASE_PUB" ]; then hm-sign sign -key /run/secrets/release_key /out/homelab-agent-linux-*; fi && \
    echo "$version" > /out/VERSION

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
    AGENT_TLS_PORT=3443 \
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
EXPOSE 3000 3443
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
