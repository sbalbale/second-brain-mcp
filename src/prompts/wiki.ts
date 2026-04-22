import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";

export function registerWikiPrompts(server: McpServer, _cfg: Config): void {
  // ---- wiki_init ----------------------------------------------------------
  server.registerPrompt(
    "wiki_init",
    {
      description: "Guided wizard to set up a fresh vault.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the librarian for a new LLM-Wiki second brain. 
Your goal is to scaffold the vault and initialize the core files.

Follow these steps:
1. Run 'wiki_scaffold' to create the directory structure.
2. Run 'wiki_log_append' with the message "Vault initialized."
3. Explain the structure to the user and ask if they have any initial sources to capture.`,
          },
        },
      ],
    })
  );

  // ---- wiki_ingest --------------------------------------------------------
  server.registerPrompt(
    "wiki_ingest",
    {
      description: "Process raw sources into structured wiki pages.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the librarian processing new raw sources into the LLM-Wiki.

Follow this playbook:
1. Run 'wiki_unprocessed_sources' to see what's in 'raw/'.
2. For each new source:
   a. Read the source file.
   b. Extract key concepts, entities, and facts.
   c. Create or update pages in 'wiki/concepts/', 'wiki/entities/', etc., using 'vault_write' (mode='merge-frontmatter' is recommended).
   d. Ensure pages have proper frontmatter (type, tags, sources).
   e. Link pages together using [[Wiki Links]].
3. Run 'wiki_index_rebuild' when finished.
4. Append a summary of your work to 'wiki/log.md' using 'wiki_log_append'.`,
          },
        },
      ],
    })
  );

  // ---- wiki_query ---------------------------------------------------------
  server.registerPrompt(
    "wiki_query",
    {
      description: "Answer a question against the wiki with [[citations]].",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are a researcher answering questions based on the LLM-Wiki.

Follow this playbook:
1. Search the vault for relevant content using 'vault_search'.
2. Use 'wiki_link_graph' to find related pages and context.
3. Read the relevant files using 'vault_batch_read'.
4. Synthesize an answer that:
   - Is grounded strictly in the wiki content.
   - Uses [[Wiki Links]] as citations to the original pages.
   - Identifies any gaps in knowledge where the wiki doesn't have the answer.`,
          },
        },
      ],
    })
  );

  // ---- wiki_lint ----------------------------------------------------------
  server.registerPrompt(
    "wiki_lint",
    {
      description: "Full health-check workflow and reporting.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are the wiki maintainer performing a health check.

Follow this playbook:
1. Run 'wiki_lint_scan' to find issues.
2. For broken links: try to find the correct target or mark them as TODO.
3. For orphan pages: find relevant pages to link them from.
4. Run 'wiki_index_rebuild' to ensure the index is up to date.
5. Report a summary of the health check to the user.`,
          },
        },
      ],
    })
  );
}
