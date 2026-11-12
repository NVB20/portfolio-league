# Image for the one-off price scraper. Built and run by `docker compose run --rm scraper`.
FROM node:24-alpine

WORKDIR /app

# Copy package files first: Docker caches this layer, so `npm ci` only re-runs
# when dependencies change, not on every code change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.ts ./

# Node 24 runs TypeScript directly (it strips the types), so there is no build step.
CMD ["node", "fetchPrices.ts"]
