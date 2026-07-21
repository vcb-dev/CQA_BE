# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Copy package files and prisma directory first to cache package installation
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (Prisma client is generated in postinstall / prisma generate hook)
RUN npm ci

# Copy the rest of the application files
COPY . .

# Build the NestJS application (xóa cache incremental — tránh chỉ emit .d.ts trong Docker)
RUN rm -rf dist tsconfig.build.tsbuildinfo && npm run build

# Remove development dependencies to keep production node_modules lightweight
RUN npm prune --omit=dev

# Stage 2: Production runner stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Prisma migrate cần openssl trên Alpine
RUN apk add --no-cache openssl

ENV NODE_ENV=production

# Copy package configurations
COPY package*.json ./

# Copy the generated prisma client, pruned node_modules, and compiled dist files
COPY --from=builder /usr/src/app/prisma ./prisma/
COPY --from=builder /usr/src/app/scripts ./scripts/
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist

# Expose the port defined in NestJS app
ENV NODE_ENV=production
ENV CSKH_RUN_MODE=api

EXPOSE 3000

# Auto-migrate trước khi start API (idempotent; Prisma advisory lock nếu nhiều replica)
# DIRECT_URL optional — fallback DATABASE_URL nếu Railway chỉ set 1 biến
# Worker: override Start Command = node dist/worker.js (không migrate lại)
CMD ["sh", "-c", "export DIRECT_URL=\"${DIRECT_URL:-$DATABASE_URL}\" && node scripts/ensure-migration-baseline.js && npx prisma migrate deploy && node dist/main.js"]
