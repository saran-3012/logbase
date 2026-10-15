# ── Stage 1: install dependencies ─────────────────────────────────────────────
FROM node:22-alpine AS deps

# @libsql/client is pure JS — no native compilation needed
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Create a non-root user for security
RUN addgroup -S logbase && adduser -S logbase -G logbase

# Copy production deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/       ./src/
COPY public/    ./public/
COPY scripts/   ./scripts/
COPY tools/     ./tools/
COPY package.json ./

RUN chown -R logbase:logbase /app

USER logbase

# HTTP API + dashboard
EXPOSE 3000
# UDP collector port range (must match UDP_PORT_RANGE; >1024 because we run non-root)
EXPOSE 10000-10010/udp

ENV NODE_ENV=production \
    PORT=3000 \
    UDP_ENABLED=true \
    UDP_BIND_HOST=0.0.0.0 \
    UDP_PORT_RANGE=10000-10010 \
    UDP_MAX_LISTENERS=1

CMD ["node", "src/server.js"]
