# syntax=docker/dockerfile:1.7

# ---- Build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install build deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev deps for runtime
RUN --mount=type=cache,target=/root/.npm npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app

# ripgrep for fast vault search; git so auto-commit works
RUN apk add --no-cache ripgrep git tini openssh-client

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRANSPORT=http \
    VAULT_ROOT=/vault

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Run as non-root. The host should chown the mounted vault to this uid,
# or set `user:` in docker-compose to match.
RUN addgroup -S app && adduser -S -G app -u 10001 app
USER app

EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--", "node", "dist/index.js"]
