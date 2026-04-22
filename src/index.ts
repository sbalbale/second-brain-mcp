import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
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

    // Disable default body parsing - MCP transport needs raw stream access
    app.set("x-powered-by", false);

    // Health check (unauthenticated) - Move ABOVE any other middleware
    app.get("/health", (req, res) => {
      console.error("Health check request received");
      res.json({ status: "ok", vault: config.VAULT_ROOT });
    });

    const server = createServer(config);
    console.error("Server created");
    
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    console.error("Transport created");
    
    // Connect the server to the transport immediately
    await server.connect(transport);
    console.error("Server connected to transport");

    // Auth middleware
    const auth = buildAuthMiddleware(config);

    // MCP endpoint handler
    // NOTE: We do NOT use express.json() here because the SDK needs the raw stream
    app.all("/mcp", auth, async (req, res) => {
      console.error(`MCP request received: ${req.method} ${req.url}`);
      console.error(`Content-Type: ${req.get("content-type")}`);
      console.error(`Auth: ${JSON.stringify((req as any).auth)}`);
      try {
        console.error("About to call transport.handleRequest...");
        await transport.handleRequest(req, res);
        console.error("transport.handleRequest returned successfully");
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? err.stack : "";
        console.error("CAUGHT ERROR in MCP handler:", errorMessage);
        if (errorStack) {
          console.error("Stack trace:", errorStack);
        }
        if (!res.headersSent) {
          try {
            res.status(500).json({ 
              error: "Internal Server Error", 
              detail: errorMessage,
              stack: process.env.NODE_ENV === "development" ? errorStack : undefined 
            });
          } catch (e) {
            console.error("Failed to send error response:", e);
          }
        }
      }
    });

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
