# Deploying with Docker

This server is designed to run in a Docker container for consistency and security.

## Image Structure

The `Dockerfile` uses a multi-stage build:
1.  **Build Stage**: Compiles TypeScript to JavaScript and installs dependencies.
2.  **Runtime Stage**: A lightweight Alpine-based image including:
    *   `node`: Runtime.
    *   `git`: Required for the `wiki_git` tools and autocommits.
    *   `ripgrep` (`rg`): Used for high-performance full-text search.
    *   `tini`: Correctly handles signal forwarding and zombie processes.

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

## Volumes and Permissions

The container runs as a non-root user (`app`, UID `10001`). 

**Crucial**: You must ensure that the directory you mount to `/vault` is readable and writable by this UID on the host, or Docker will encounter permission errors when trying to write files or perform git operations.

You can fix permissions on the host:
```bash
sudo chown -R 10001:10001 /path/to/your/vault
```

## Git Support

For `wiki_git_status` and `VAULT_AUTOCOMMIT` to work, the mounted vault directory must be a git repository (`git init`). The container uses the local `git` binary to perform operations. Ensure you have configured a `user.name` and `user.email` within the vault's git config if you encounter commit errors.
