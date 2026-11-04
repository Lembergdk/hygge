# Build context: backend/cloudflare. Deployment must use the resulting immutable image digest.
FROM node:22.22.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/container
COPY container/package.json container/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY container/server.mjs container/artifacts.mjs ./
COPY src/browser-live.ts src/browser-control.ts src/browser-observation.ts src/workspace-container-protocol.ts src/workspace-security.ts src/workspace-contract.ts /srv/src/
RUN mkdir -p /workspace && chown node:node /workspace
ENV HOME=/workspace CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","--experimental-strip-types","server.mjs"]
