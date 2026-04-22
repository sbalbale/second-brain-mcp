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
    app.use(express.json());

    // Health check (unauthenticated)
    app.get("/health", (req, res) => {
      res.json({ status: "ok", vault: config.VAULT_ROOT });
    });

    // Auth middleware for MCP endpoints
    const auth = buildAuthMiddleware(config);
    app.use("/mcp", auth);

    const server = createServer(config);
    
    // StreamableHTTPServerTransport is stateless or stateful. 
    // For many clients, stateless is easier behind a load balancer, but
    // stateful (default) is better for SSE.
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);

    app.all("/mcp", async (req, res) => {
      await transport.handleRequest(req, res);
    });

    const port = config.PORT;
    const host = config.HOST;
    app.listen(port, host, () => {
      console.error(`Second Brain MCP (http) listening on ${host}:${port}/mcp`);
      console.error(`Vault: ${config.VAULT_ROOT}`);
    });
  }
}

main().catch((err) => {
  console.error("Fatal error during startup:");
  console.error(err);
  process.exit(1);
});
