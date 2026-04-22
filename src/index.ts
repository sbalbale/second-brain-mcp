import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { buildAuthMiddleware, assertAuthConfigured } from "./auth.js";

async function main() {
  const config = loadConfig();

  if (config.TRANSPORT === "stdio") {
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`Second Brain MCP (stdio) running. Vault: ${config.VAULT_ROOT}`);
  } else {
    assertAuthConfigured(config);

    const app = express();

    // Health check (unauthenticated) - Move ABOVE any other middleware
    app.get("/health", (req, res) => {
      console.error("Health check request received");
      res.json({ status: "ok", vault: config.VAULT_ROOT });
    });

    const server = createServer(config);
    const transport = new StreamableHTTPServerTransport();
    
    // Connect the server to the transport immediately
    await server.connect(transport);

    // MCP endpoint handler
    // NOTE: We do NOT use express.json() here because the SDK needs the raw stream
    app.all("/mcp", async (req, res) => {
      console.error(`MCP request received: ${req.method}`);
      try {
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("Error handling MCP request:", err);
        res.status(500).send("Internal Server Error");
      }
    });

    // Auth middleware for other potential endpoints
    const auth = buildAuthMiddleware(config);
    // app.use(auth); // Apply selectively if needed

    const port = config.PORT;
    const host = config.HOST;
    app.listen(port, host, () => {
      console.error(`Second Brain MCP (http) listening on ${host}:${port}`);
      console.error(`MCP endpoint: http://${host}:${port}/mcp`);
      console.error(`Health check: http://${host}:${port}/health`);
    });
  }
}

main().catch((err) => {
  console.error("Fatal error during startup:");
  console.error(err);
  process.exit(1);
});
