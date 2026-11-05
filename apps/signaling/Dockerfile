# DropBeam signaling server — production container.
# Works on Render, Fly.io, Railway, Cloud Run, and any Docker host.

# Pinned to the Bun version CI tests with. Bump deliberately, together with
# .github/workflows/ci.yml.
FROM oven/bun:1.3.12-alpine AS deps
WORKDIR /app

# Copy every workspace manifest so the lockfile matches exactly, then install
# deterministically. --production skips dev tooling (Vite, TypeScript, …).
COPY package.json bun.lock ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/transfer/package.json ./packages/transfer/
COPY apps/signaling/package.json ./apps/signaling/
COPY apps/web/package.json ./apps/web/
RUN bun install --frozen-lockfile --production

# ─── runtime stage ───
FROM oven/bun:1.3.12-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Render injects PORT; Fly defaults to 8080; locally we honor any value.
ENV HOST=0.0.0.0
ENV PORT=8787

# Copy the whole installed tree: Bun links workspace packages inside each
# workspace's own node_modules (e.g. apps/signaling/node_modules/@dropbeam),
# not only the root one. Then lay the sources over it (the build context
# excludes node_modules, so the links survive).
COPY --from=deps /app ./
COPY packages/protocol ./packages/protocol
COPY apps/signaling ./apps/signaling

# Drop privileges.
USER bun

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["bun", "apps/signaling/src/server.ts"]
