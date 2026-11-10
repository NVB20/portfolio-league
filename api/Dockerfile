# Image for the API. Built and published to GHCR by .github/workflows/ci.yml on every push to main.
# Run:     docker run -p 3000:3000 -e DATABASE_URL=... -e FIREBASE_PROJECT_ID=... -e CORS_ORIGINS=... <image>
# Migrate: docker run --rm -e DATABASE_URL=... <image> npm run migrate

# --- Build: bundle src/ into one file with esbuild (needs the dev dependencies) ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Run: only the production dependencies, the bundle and the migrations ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "dist/server.mjs"]
