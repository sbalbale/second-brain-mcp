import http from "http";

// Test the HTTP MCP endpoint after starting the server

async function testHttpMcp() {
  const port = 8787;
  const token = "test-token";
  
  // Wait a bit for server to start (in case it's being started separately)
  await new Promise(r => setTimeout(r, 500));
  
  console.log("Testing HTTP MCP endpoint...\n");
  
  // Test 1: POST /mcp with initialize
  console.log("Test 1: POST initialize request");
  const initResult = await makeRequest(port, "POST", "/mcp", 
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0" } } },
    token
  );
  console.log(`Status: ${initResult.status}`);
  console.log(`Response type: ${typeof initResult.body}`);
  
  if (initResult.status !== 200) {
    console.error("✗ Initialize failed");
    console.error(initResult.body);
    process.exit(1);
  }
  console.log("✓ Initialize succeeded\n");
  
  // Test 2: POST /mcp with tools/list
  console.log("Test 2: POST tools/list request");
  const toolsResult = await makeRequest(port, "POST", "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    token
  );
  console.log(`Status: ${toolsResult.status}`);
  
  if (toolsResult.status !== 200) {
    console.error("✗ tools/list failed");
    console.error(toolsResult.body);
    process.exit(1);
  }
  console.log("✓ tools/list succeeded\n");
  
  // Test 3: POST /mcp with prompts/list
  console.log("Test 3: POST prompts/list request");
  const promptsResult = await makeRequest(port, "POST", "/mcp",
    { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
    token
  );
  console.log(`Status: ${promptsResult.status}`);
  
  if (promptsResult.status !== 200) {
    console.error("✗ prompts/list failed");
    console.error(promptsResult.body);
    process.exit(1);
  }
  console.log("✓ prompts/list succeeded\n");
  
  console.log("✓ All tests passed!");
  process.exit(0);
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
      hostname: "localhost",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode || 500, body: data });
      });
    });

    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

testHttpMcp().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
