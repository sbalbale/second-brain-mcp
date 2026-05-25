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

# Install qmd for local semantic search (no API key needed; models download on first embed)
RUN npm install -g @tobilu/qmd

# Run as non-root. The host should chown the mounted vault to this uid,
# or set `user:` in docker-compose to match.
RUN addgroup -S app && adduser -S -G app -u 10001 app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER app

EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh", "node", "dist/index.js"]
