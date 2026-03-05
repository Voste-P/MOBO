# ─── Multi-stage Dockerfile for MOBO Backend ────────────────────────────────
# Stage 1: Build the TypeScript backend
# Stage 2: Production-optimized image with only runtime dependencies
#
# Build:  docker build -t mobo-backend ./backend
# Run:    docker run -p 8080:8080 --env-file .env mobo-backend

# ─── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace files for npm workspaces resolution
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts

# Copy source code
COPY backend/ backend/
COPY shared/ shared/

# Generate Prisma client
RUN cd backend && npx prisma generate

# Build TypeScript
RUN npm -w @mobo/backend run build

# ─── Stage 2: Production ────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Install tini for proper PID 1 signal handling (SIGTERM → graceful shutdown)
RUN apk add --no-cache tini

# Security: run as non-root user
RUN addgroup -g 1001 -S mobo && \
    adduser -S mobo -u 1001 -G mobo

WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built artifacts
COPY --from=builder /app/backend/dist backend/dist
COPY --from=builder /app/backend/generated backend/generated
COPY --from=builder /app/backend/prisma backend/prisma

# Copy shared (needed at runtime for type imports resolved via dist)
COPY --from=builder /app/shared shared/

# Create logs directory
RUN mkdir -p backend/logs && chown -R mobo:mobo backend/logs

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

# Switch to non-root user
USER mobo

# Expose port
EXPOSE 8080

# Start the server with tini for proper signal forwarding
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "cd backend && npx prisma migrate deploy && node dist/index.js"]
