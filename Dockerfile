# Multi-stage production Dockerfile for @perfect-swarm/core & Swarm Server
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy source files
COPY . .

# Build Vite web client and compiled Swarm distribution library
RUN npm run build

# Production runtime stage
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy package files and install production-only dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy build artifacts and runtime server files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./server.ts

# Ensure CLI executable permissions
RUN chmod +x ./bin/cli.js

# Expose HTTP & SSE streaming port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start production server
CMD ["node", "--experimental-strip-types", "server.ts"]
