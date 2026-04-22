#!/usr/bin/env node
// Quick HTTP integration test
import { spawn } from "child_process";
import http from "http";

const token = "test-token-12345678901234567890";
const port = 8787;

process.env.VAULT_ROOT = "./test-vault";
process.env.TRANSPORT = "http";
process.env.AUTH_TOKEN = token;
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";

console.log("Starting MCP server in HTTP mode...\n");

const server = spawn("node", ["dist/index.js"], {
  cwd: process.cwd(),
  stdio: ["ignore", "inherit", "inherit"],
});

await new Promise(r => setTimeout(r, 2000));

try {
  // Test with Accept: */* (like VS Code MCP client does)
  const result = await makeRequest(port, "POST", "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    },
    token,
    "*/*"  // Send wildcard Accept header like VS Code does
  );
  
  if (result.status !== 200) {
    console.error(`✗ FAILED: Got ${result.status}`);
    console.error(result.body);
    process.exit(1);
  }
  
  const parsed = JSON.parse(result.body);
  if (parsed.error) {
    console.error(`✗ FAILED: Got error response:`, parsed.error);
    process.exit(1);
  }
  
  if (!parsed.result || !parsed.result.serverInfo) {
    console.error(`✗ FAILED: Unexpected response structure`);
    console.error(parsed);
    process.exit(1);
  }
  
  console.log("✓ HTTP Initialize passed (with Accept: */*)");
  console.log("✓ All tests passed!");
  process.exit(0);
} catch (err) {
  console.error("Test failed:", err);
  process.exit(1);
} finally {
  server.kill();
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body: any,
  token: string,
  acceptHeader: string = "application/json"
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(body && { "Content-Type": "application/json" }),
        "Authorization": `Bearer ${token}`,
        "Accept": acceptHeader,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode || 500, body: data });
      });
    });

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}
