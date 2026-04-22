# Deploying with Cloudflare Tunnel

This guide explains how to expose your `second-brain-mcp` server to the public internet securely using Cloudflare Zero Trust. This setup allows your LLM (like Claude.ai or a remote instance) to talk to your local Obsidian vault without opening any inbound ports on your router.

## Prerequisites

1.  A Cloudflare account with a registered domain.
2.  Docker and Docker Compose installed on the machine where your Obsidian vault lives.
3.  An Obsidian vault directory.

## Step 1: Create a Cloudflare Tunnel

1.  Go to the [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2.  Navigate to **Networks** > **Tunnels**.
3.  Click **Create a Tunnel**.
4.  Choose **Cloudflare Tunnel** (connector) and give it a name (e.g., `second-brain-mcp`).
5.  In the "Install and run a connector" step, copy the **Tunnel Token**. You will need this for your `.env` file.
6.  In the **Public Hostname** tab:
    *   **Public Hostname**: Choose a subdomain (e.g., `vault.yourdomain.com`).
    *   **Service**:
        *   Type: `HTTP`
        *   URL: `mcp:8787` (This refers to the internal Docker service name).
7.  Save the tunnel.

## Step 2: Set up Cloudflare Access (Authentication)

To ensure *only you* can access the vault, we use Cloudflare Access.

1.  In the Zero Trust Dashboard, go to **Access** > **Applications**.
2.  Click **Add an Application** > **Self-hosted**.
3.  **Application Name**: `Second Brain MCP`.
4.  **Domain**: The hostname you chose in Step 1 (e.g., `vault.yourdomain.com`).
5.  Under **Policies**, create a policy that allows your email address.
6.  In the **Settings** tab:
    *   Scroll down to **Application Appearance**.
    *   Look for the **AUD (Audience Tag)**. Copy this string; you'll need it for `CF_ACCESS_AUD`.
7.  Note your **Team Domain** (usually `your-team.cloudflareaccess.com`).

## Step 3: Configure Environment Variables

Create a `.env` file in the root of the project:

```bash
# Absolute path to your Obsidian vault on the host machine
VAULT_PATH=/Users/username/Documents/MyVault

# Generate a strong token: openssl rand -hex 32
AUTH_TOKEN=your_generated_bearer_token

# From Cloudflare Tunnel setup
CF_TUNNEL_TOKEN=your_cloudflare_tunnel_token

# From Cloudflare Access setup
CF_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com
CF_ACCESS_AUD=your_application_audience_tag

# Git autocommit behavior
VAULT_AUTOCOMMIT=true
```

## Step 4: Launch

Run the stack:

```bash
docker compose up -d
```

## Step 5: Verify

1.  Check the logs: `docker compose logs -f mcp`.
2.  Visit `https://vault.yourdomain.com/health` in your browser.
3.  You should be prompted to log in via Cloudflare Access.
4.  Once logged in, you should see `{"status":"ok"}`.

## Troubleshooting

*   **Tunnel Down**: Check the `cloudflared` container logs: `docker compose logs cloudflared`.
*   **401 Unauthorized**: Ensure your client is sending the `Authorization: Bearer <AUTH_TOKEN>` header.
*   **JWT Errors**: Double-check the `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` in your `.env`.
