import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import type { Config } from "./config.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerWikiPrompts } from "./prompts/wiki.js";

export function createServer(cfg: Config): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register tools
  registerVaultTools(server, cfg);
  registerWikiTools(server, cfg);

  // Register prompts
  registerWikiPrompts(server, cfg);

  return server;
}
