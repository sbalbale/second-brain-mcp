import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";

/**
 * Canonical wikilink rules for this vault (per its CLAUDE.md). Embedded in every
 * link-writing prompt so any MCP client produces links that survive CLI edits.
 */
const WIKILINK_RULES = `## Wikilink rules (follow exactly)

Always link by the target's FILENAME SLUG plus a Title Case display label:

    [[kebab-basename|Display Name]]

- Link by the filename slug (the basename, no .md), then \`|\`, then the Title Case name.
  ✅ [[music-account-service|Music Account Service]]   ✅ [[astrape-ai|Astrape AI]]
  ❌ [[Astrape AI]] — bare alias links depend on Obsidian's alias cache and break after CLI edits; the filename slug always resolves.

1. EXISTING PAGES ONLY. Before writing [[x]], verify the page exists (check wiki/index.md or the file). If it does not exist, write plain text — no brackets. Never link a non-existent page; it pollutes the graph with phantom blank pages.
2. RAW SOURCES are linked by full vault path, not basename (raw/ and wiki/ can share basenames): [[raw/inbox/2026-05-25-session-sync.md]] (optionally [[raw/inbox/file.md|label]]).
3. LINK AGGRESSIVELY — link every mention of an entity, concept, project, person, or tool that has its own page. Don't leave plain text where a page exists.
4. LINK ON FIRST MENTION PER SECTION — link a page the first time it appears in each section; don't repeat the same link within that section.
5. Every page MUST carry an \`aliases\` frontmatter field with its display name — this powers search/autocomplete and catches stray alias links.`;

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
   d. Ensure pages have proper frontmatter (type, aliases, tags, sources).
   e. Link pages together following the wikilink rules below.
3. Run 'wiki_index_rebuild' when finished.
4. Append a summary of your work to 'wiki/log.md' using 'wiki_log_append'.

${WIKILINK_RULES}`,
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
   - Cites original pages with wikilinks (see rules below).
   - Identifies any gaps in knowledge where the wiki doesn't have the answer.

${WIKILINK_RULES}`,
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
1. Run 'wiki_lint_scan' to find issues (broken/ambiguous links, orphans, missing frontmatter).
2. Run 'wiki_lint_fix' with dry_run=true to preview the mechanical fixes (frontmatter scaffolding, index drift, unambiguous link normalization), then dry_run=false to apply them.
3. For remaining broken links: find the correct target (link by filename slug — see rules below) or mark them as TODO. Leave ambiguous links for human review.
4. For orphan pages: find relevant pages to link them from.
5. Report a summary of the health check to the user.

${WIKILINK_RULES}`,
          },
        },
      ],
    })
  );
}
