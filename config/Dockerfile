# Cadence as a team server: one always-on Cadence that a team signs in to from
# the desktop app or a browser. See docs/team-server.md.
#
#   docker build -f config/Dockerfile -t cadence .
#   docker run -p 4317:4317 -v cadence-data:/data \
#     -e CADENCE_OWNER_EMAIL=you@example.com -e CADENCE_OWNER_PASSWORD=... cadence

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:desktop && npm prune --omit=dev

FROM node:24-bookworm-slim
# git for workspaces; Chromium for the built-in browser, canvas screenshots, and visual checks.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates chromium fonts-liberation tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
  CADENCE_HOST=0.0.0.0 \
  CADENCE_DATA_DIR=/data \
  CADENCE_CHROME=/usr/bin/chromium \
  CADENCE_CHROME_ARGS=--no-sandbox \
  GIT_TERMINAL_PROMPT=0
VOLUME /data
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.CADENCE_PORT||4317)+'/api/orgs').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/desktop/server.mjs"]
