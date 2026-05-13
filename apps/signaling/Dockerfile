# DropBeam signaling server — production container.
# Works on Render, Fly.io, Railway, Cloud Run, and any Docker host.

FROM oven/bun:1.1-alpine AS deps
WORKDIR /app

# Copy workspace manifests first for cache-friendly installs.
COPY package.json bun.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/signaling/package.json ./apps/signaling/

# Install only what's needed (protocol is the signaling server's only dep).
RUN bun install --frozen-lockfile --production

# ─── runtime stage ───
FROM oven/bun:1.1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Render injects PORT; Fly defaults to 8080; locally we honor any value.
ENV HOST=0.0.0.0
ENV PORT=8787

# Copy node_modules + source.
COPY --from=deps /app/node_modules ./node_modules
COPY packages/protocol ./packages/protocol
COPY apps/signaling ./apps/signaling

# Drop privileges.
USER bun

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["bun", "apps/signaling/src/server.ts"]
