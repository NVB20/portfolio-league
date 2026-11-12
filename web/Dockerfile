# Image for the web app: the Expo web export, served as static files by nginx. Built by docker-compose.yml (D-042),
# with the repo root as its build context (see the root .dockerignore).
#
# The EXPO_PUBLIC_* values are built into the JavaScript at export time. They are public by design (the Firebase web
# config and the API's address), never secrets. Changing one means rebuilding: docker compose up --build web

# --- Build: export the app for the web (the same command CI runs) ---
FROM node:22-alpine AS build
WORKDIR /app
ENV CI=1 EXPO_NO_TELEMETRY=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build args are environment variables for the RUN below, which is where Expo reads them.
ARG EXPO_PUBLIC_API_URL
ARG EXPO_PUBLIC_FIREBASE_API_KEY
ARG EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG EXPO_PUBLIC_FIREBASE_PROJECT_ID
ARG EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG EXPO_PUBLIC_FIREBASE_APP_ID
RUN npx expo export --platform web

# --- Serve: nginx with the exported files ---
FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
