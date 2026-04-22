#!/usr/bin/env -S NODE_OPTIONS="--no-warnings" node
import { spawn } from "child_process";
import http from "http";

// Start the server in HTTP mode and test it

async function runHttpTest() {
  const token = "test-token-12345678901234567890";
  const port = 8787;
  
  // Set up environment
  process.env.VAULT_ROOT = "./test-vault";
  process.env.TRANSPORT = "http";
  process.env.AUTH_TOKEN = token;
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";
  
  console.log("Starting MCP server in HTTP mode...\n");
  
  // Start the server
  const server = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  
  // Wait for server to start
  await new Promise(r => setTimeout(r, 2000));
  
  try {
    console.log("\n=== Running Tests ===\n");
    
    // Test 1: Initialize
    console.log("Test 1: POST initialize");
    let result = await makeRequest(port, "POST", "/mcp",
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
      token
    );
    
    if (result.status !== 200) {
      console.error(`✗ FAILED: Got ${result.status}`);
      console.error(result.body);
      throw new Error("Test 1 failed");
    }
    console.log("✓ PASSED\n");
    
    // Test 2: tools/list
    console.log("Test 2: POST tools/list");
    result = await makeRequest(port, "POST", "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      token
    );
    
    if (result.status !== 200) {
      console.error(`✗ FAILED: Got ${result.status}`);
      console.error(result.body);
      throw new Error("Test 2 failed");
    }
    console.log("✓ PASSED\n");
    
    // Test 3: prompts/list
    console.log("Test 3: POST prompts/list");
    result = await makeRequest(port, "POST", "/mcp",
      { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
      token
    );
    
    if (result.status !== 200) {
      console.error(`✗ FAILED: Got ${result.status}`);
      console.error(result.body);
      throw new Error("Test 3 failed");
    }
    console.log("✓ PASSED\n");
    
    // Test 4: Health check
    console.log("Test 4: GET /health");
    result = await makeRequest(port, "GET", "/health", null, token);
    
    if (result.status !== 200) {
      console.error(`✗ FAILED: Got ${result.status}`);
      console.error(result.body);
      throw new Error("Test 4 failed");
    }
    console.log("✓ PASSED\n");
    
    console.log("=== All Tests Passed! ===");
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.kill();
  }
}

function makeRequest(
  port: number,
  method: string,
  path: string,
  body: any,
  token: string
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

// Start the test
runHttpTest().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
