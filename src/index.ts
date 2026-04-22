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

    // Parse incoming request body for transport
    app.use(express.json({ limit: "100mb" }));

    // Health check (unauthenticated) - Move ABOVE any other middleware
    app.get("/health", (req, res) => {
      console.error("Health check request received");
      res.json({ status: "ok", vault: config.VAULT_ROOT });
    });

    const server = createServer(config);
    console.error("Server created");
    
    // Use stateless mode: no session ID required
    // This is better for HTTP clients connecting over the internet
    // Stateful mode would require the client to track session IDs
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    console.error("Transport created (stateless mode)");
    
    // Connect the server to the transport immediately
    await server.connect(transport);
    console.error("Server connected to transport");

    // Auth middleware
    const auth = buildAuthMiddleware(config);

    // MCP endpoint handler
    app.all("/mcp", auth, async (req, res) => {
      const startTime = Date.now();
      console.error(`\n=== MCP Request Start ===`);
      console.error(`Time: ${new Date().toISOString()}`);
      console.error(`Method: ${req.method}`);
      console.error(`URL: ${req.url}`);
      console.error(`Content-Type: ${req.get("content-type")}`);
      console.error(`Accept: ${req.get("accept")}`);
      console.error(`Auth: ${JSON.stringify((req as any).auth)}`);
      console.error(`Request body type: ${typeof (req as any).body}`);
      if ((req as any).body) {
        const bodyStr = JSON.stringify((req as any).body).substring(0, 200);
        console.error(`Request body: ${bodyStr}`);
      }
      
      res.on("error", (err) => {
        console.error(`Response ERROR event: ${err.message}`);
        console.error(err.stack);
      });
      
      try {
        console.error("Calling transport.handleRequest()...");
        // Pass parsed body to transport
        await transport.handleRequest(req, res, (req as any).body);
        const duration = Date.now() - startTime;
        console.error(`✓ transport.handleRequest() completed in ${duration}ms`);
        console.error(`Response status code: ${res.statusCode}`);
      } catch (err) {
        const duration = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorStack = err instanceof Error ? err.stack : "";
        console.error(`✗ EXCEPTION in transport.handleRequest() after ${duration}ms: ${errorMessage}`);
        if (errorStack) {
          console.error(`Stack trace:\n${errorStack}`);
        }
        
        if (!res.headersSent) {
          try {
            res.status(500).json({ 
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Internal Server Error",
                data: {
                  detail: errorMessage,
                  stack: process.env.NODE_ENV === "development" ? errorStack : undefined 
                }
              },
              id: null
            });
          } catch (e) {
            console.error("Failed to send error response:", e);
          }
        }
      }
      console.error(`=== MCP Request End ===\n`);
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
