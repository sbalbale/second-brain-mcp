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

    // Normalize Accept header BEFORE any other processing
    // The MCP SDK requires both "application/json" and "text/event-stream"
    // We must modify both headers and rawHeaders since the HTTP transport layer may read from either
    app.use((req, res, next) => {
      const accept = req.get("accept");
      if (!accept || accept === "*/*") {
        const newAccept = "application/json, text/event-stream";
        req.headers.accept = newAccept;
        
        // Also modify rawHeaders which Node.js uses internally
        const rawHeaders = req.rawHeaders || [];
        const acceptIndex = rawHeaders.findIndex(h => h && h.toLowerCase() === "accept");
        if (acceptIndex >= 0) {
          rawHeaders[acceptIndex + 1] = newAccept;
        } else {
          rawHeaders.push("Accept", newAccept);
        }
        (req as any).rawHeaders = rawHeaders;
        
        if (!req.url?.startsWith("/health")) {
          console.error(`[Middleware] Normalized Accept header from "${accept}" to "${newAccept}"`);
        }
      }
      next();
    });

    // Parse incoming request body for transport
    app.use(express.json({ limit: "100mb" }));

    // Health check (unauthenticated) - Move ABOVE any other middleware
    app.get("/health", (req, res) => {
      console.error("Health check request received");
      res.json({ status: "ok", vault: config.VAULT_ROOT });
    });

    const server = createServer(config);
    console.error("Server created");

    // Create a single transport instance for HTTP mode
    // Note: We use enableJsonResponse: true to get JSON responses instead of SSE,
    // which works better with stateless clients like VS Code's MCP extension
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Connect the server to the transport once at startup
    await server.connect(transport);
    console.error("Server connected to transport");

    // Auth middleware
    const auth = buildAuthMiddleware(config);

    // MCP endpoint handler
    app.all("/mcp", auth, async (req, res, next) => {
      try {
        // Pass parsed body to transport - only pass body for requests that have content
        const bodyToPass = req.method === 'GET' ? undefined : (req as any).body;
        await transport.handleRequest(req, res, bodyToPass);
      } catch (err) {
        // If transport throws an error, send error response if headers haven't been sent
        if (!res.headersSent) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          res.status(500).json({ 
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Internal Server Error",
              data: { detail: errorMessage }
            },
            id: null
          });
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
