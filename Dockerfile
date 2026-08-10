# syntax=docker/dockerfile:1

# --- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` needs a lockfile; fall back to `install` on a fresh checkout.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# curl is used by the compose health-check.
RUN apk add --no-cache curl tini

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY views ./views

# Run unprivileged. `node` (uid 1000) ships with the base image.
USER node

# Hosts like Railway, Render and Fly inject their own PORT; default to 3000 locally.
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini reaps zombies and forwards SIGTERM so our graceful shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
