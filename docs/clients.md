# Connecting Clients

Once your `second-brain-mcp` server is running, you can connect it to various MCP-compatible clients.

## 1. Claude Desktop (Local)

If running locally with `TRANSPORT=stdio`:

Edit your `claude_desktop_config.json`:
*   **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
*   **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "second-brain": {
      "command": "node",
      "args": ["/path/to/second-brain-mcp/dist/index.js"],
      "env": {
        "VAULT_ROOT": "/path/to/your/vault",
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

## 2. Remote Clients (HTTP)

If you are using the Cloudflare Tunnel setup, your server is reachable via HTTPS.

### Connection Details
*   **URL**: `https://vault.yourdomain.com/mcp`
*   **Headers**: 
    *   `Authorization: Bearer <YOUR_AUTH_TOKEN>`

### Note on SSE (Server-Sent Events)
The server uses the MCP `StreamableHTTPServerTransport`. It supports:
1.  **Long-polling**: Standard HTTP POST requests.
2.  **SSE**: A persistent connection for server-to-client notifications (required for some advanced MCP features).

### Using with Claude.ai (via Proxy)
Current web-based LLMs often require a bridge or a specific MCP-over-HTTP proxy. Ensure your proxy forwards the `Authorization` header and correctly handles the `Cf-Access-Jwt-Assertion` if you are using Cloudflare Access.

## 3. Testing with `curl`

You can test the health and auth of your remote deployment:

```bash
# Health check
curl https://vault.yourdomain.com/health

# MCP List Tools (requires Auth)
curl -X POST https://vault.yourdomain.com/mcp \
  -H "Authorization: Bearer your_token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
