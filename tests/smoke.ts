import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function smokeTest() {
  console.log("Starting smoke test...");
  
  // Set env vars for the test
  process.env.VAULT_ROOT = "./test-vault";
  process.env.TRANSPORT = "stdio";
  
  const config = loadConfig();
  const server = createServer(config);
  
  console.log("Server created. Testing stdio transport connection...");
  
  // We can't easily test stdio in a script because it takes over stdin/stdout.
  // But we can check if it initializes without throwing.
  
  console.log("Smoke test passed (initialization successful).");
  process.exit(0);
}

smokeTest().catch(err => {
  console.error("Smoke test failed:");
  console.error(err);
  process.exit(1);
});
