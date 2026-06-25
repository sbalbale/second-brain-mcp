# Deploying with Docker

This server is designed to run in a Docker container for consistency and security.

## Image Structure

The `Dockerfile` uses a multi-stage build:
1.  **Build Stage**: Compiles TypeScript to JavaScript and installs dependencies.
2.  **Runtime Stage**: A lightweight Debian slim image including:
    *   `node`: Runtime.
    *   `git`: Required for the `wiki_git` tools and autocommits.
    *   `ripgrep` (`rg`): Used for high-performance full-text search.
    *   `tini`: Correctly handles signal forwarding and zombie processes.

The provided `docker-compose.yml` runs three self-hosted services on a private Docker network:

* `mcp`: the MCP server.
* `redis`: shared cache for bursty read/search/RAG workloads.
* `cloudflared`: outbound Cloudflare Tunnel sidecar.

Redis is not published to the host; the MCP container reaches it at `redis://redis:6379`.

## Running Standalone

If you don't want to use the Cloudflare Tunnel sidecar, you can run the MCP server alone.

### 1. Build the image
```bash
docker build -t second-brain-mcp .
```

### 2. Run the container
```bash
docker run -d \
  --name mcp-server \
  -v /path/to/your/vault:/vault \
  -e VAULT_ROOT=/vault \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=my-secret-token \
  -p 8787:8787 \
  second-brain-mcp
```

For higher throughput in standalone mode, run a self-hosted Redis container on the same Docker network and pass `REDIS_URL`:

```bash
docker network create second-brain
docker run -d --name second-brain-redis --network second-brain redis:7-alpine
docker run -d \
  --name mcp-server \
  --network second-brain \
  -v /path/to/your/vault:/vault \
  -e VAULT_ROOT=/vault \
  -e TRANSPORT=http \
  -e AUTH_TOKEN=my-secret-token \
  -e REDIS_URL=redis://second-brain-redis:6379 \
  -p 8787:8787 \
  second-brain-mcp
```

## Volumes and Permissions

The container runs as a non-root user (`app`, UID `10001`). 

**Crucial**: You must ensure that the directory you mount to `/vault` is readable and writable by this UID on the host, or Docker will encounter permission errors when trying to write files or perform git operations.

You can fix permissions on the host:
```bash
sudo chown -R 10001:10001 /path/to/your/vault
```

## Git Support

For `wiki_git_status` and `VAULT_AUTOCOMMIT` to work, the mounted vault directory must be a git repository (`git init`). The container uses the local `git` binary to perform operations. Ensure you have configured a `user.name` and `user.email` within the vault's git config if you encounter commit errors.

### Remote sync (`wiki_sync` / `wiki_pull`)

Pushing and pulling require a configured remote and credentials reachable from inside the container. For SSH remotes, mount your key (e.g. into `/home/docker/obsidian-ssh`) and make sure it is owned by the container user — if push/pull fails on permissions, re-apply:

```bash
sudo chown -R 10001:10001 /home/docker/obsidian-ssh
```

`wiki_pull` defaults to a fast-forward-only pull so it never creates a merge commit unattended; divergence and rebase conflicts are returned as data for you to resolve, never auto-resolved.

## Throughput Tuning

The defaults favor correctness for a vault-backed service:

```env
CACHE_ENABLED=true
REDIS_URL=redis://redis:6379
CACHE_TTL_SECONDS=30
MAX_READ_CONCURRENCY=16
MAX_WRITE_CONCURRENCY=1
GIT_CONCURRENCY=1
RAG_QUERY_CONCURRENCY=2
QMD_UPDATE_DEBOUNCE_MS=2000
```

Increase `MAX_READ_CONCURRENCY` on machines with fast SSDs and spare CPU. Keep write and git concurrency at `1` unless you have a specific reason to risk more parallel mutation.
