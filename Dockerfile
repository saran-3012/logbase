# ── Stage 1: build dependencies ───────────────────────────────────────────────
FROM node:22-alpine AS deps

# better-sqlite3 is a native module and needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S logbase && adduser -S logbase -G logbase

# Copy compiled native modules and production deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/       ./src/
COPY public/    ./public/
COPY package.json ./

# Create the data directory (SQLite DB lives here) and set ownership
RUN mkdir -p /app/data && chown -R logbase:logbase /app

USER logbase

# Mount this volume to persist the SQLite database across container restarts
VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000

CMD ["node", "src/server.js"]
