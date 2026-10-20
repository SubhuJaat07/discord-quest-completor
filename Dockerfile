# ============================================================
# Discord Quest Completor — Docker build (direct REST API engine)
# No Chromium/Puppeteer → tiny image, fast builds
# ============================================================

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only manifests for layer caching
COPY package.json package-lock.json* bun.lock* ./

# Install FULL dependencies (dev deps are REQUIRED at build time:
# @tailwindcss/postcss, tailwindcss, tw-animate-css, typescript are devDependencies).
# The final runtime image stays small because `output: standalone` only bundles
# the modules the server actually needs.
RUN npm ci --ignore-scripts || npm install --ignore-scripts

# ---------- Stage 2: build ----------
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------- Stage 3: runtime ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# PORT is overridden automatically by Railway/Coolify — server.js honors it
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Persistent data (24h monitor state — encrypted at rest).
# Coolify: mount a volume at /app/data · Railway: add a volume · compose: see docker-compose.yml
ENV DATA_DIR=/app/data

# Non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Standalone output contains a minimal server + only needed node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Writable data dir for the nextjs user (survives redeploys when volume-mounted)
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

EXPOSE 3000

# Health check honors $PORT so dynamic port platforms (Coolify) work out of the box
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD sh -c "wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1"

CMD ["node", "server.js"]
