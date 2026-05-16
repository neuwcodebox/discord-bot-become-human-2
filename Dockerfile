# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-bookworm AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

# System packages available to the bwrap sandbox (bound from /usr, /bin, /lib)
# and general bot utilities.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bubblewrap \
        python3 \
        python3-pip \
        gawk \
        jq \
        curl \
        wget \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# setuid lets bwrap create namespaces without requiring --privileged on the
# Docker host.  The bot process never gains extra privileges; bwrap drops
# them after namespace setup.
RUN chmod u+s /usr/bin/bwrap

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Built artefacts + runtime assets
COPY --from=builder /app/dist ./dist
COPY resources ./resources
COPY templates ./templates

# Persistent data: config.json, codex-auth.json, guild workspaces
# Mount this on the host so data survives container restarts.
VOLUME /root/.discord-bot-become-human-2

ENV NODE_ENV=production

# Pass secrets via environment or mount a .env file to /app/.env
# Required at minimum: DISCORD_BOT_TOKEN (or whichever tokenEnv names)

CMD ["node", "dist/index.js"]
