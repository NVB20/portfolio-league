# Image for the API. Built and published to GHCR by .github/workflows/ci.yml on every push to main.
# Run:     docker run -p 3000:3000 -e DATABASE_URL=... -e FIREBASE_PROJECT_ID=... -e CORS_ORIGINS=... <image>
# Migrate: docker run --rm -e DATABASE_URL=... <image> node_modules/.bin/node-pg-migrate up --migrations-dir migrations
#          (the same as `npm run migrate`, without npm: the image has no package manager, see the last stage)

# --- Build: bundle src/ into one file with esbuild (needs the dev dependencies) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Tools: the seed scripts, run with tsx (a dev dependency). Used only by docker-compose.yml's `seed` job ---
# Built only when asked for (`target: tools`); a plain `docker build` skips it, so the published image is unchanged.
FROM build AS tools
COPY migrations ./migrations
COPY scripts ./scripts
CMD ["npx", "tsx", "scripts/compose-seed.ts"]

# --- Run: only the production dependencies, the bundle and the migrations ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# npm installs the dependencies, then every package manager the base image ships is removed (npm, npx, corepack,
# yarn): the server never runs them, and CI's Trivy scan found high CVEs only in npm's own bundled packages.
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
