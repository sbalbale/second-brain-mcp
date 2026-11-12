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

/** Shared first step: the vault's own AGENTS.md is the rulebook every client follows. */
const RULEBOOK_STEP = `Before anything else, read the vault's rulebook: vault_read path "AGENTS.md" (if next_offset is not null, keep reading with offset=next_offset). Where it differs from this prompt, AGENTS.md wins.`;

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

${RULEBOOK_STEP}

Follow this playbook:
1. Run 'wiki_unprocessed_sources' to see what's in 'raw/'. (A URL the user gives you: save it first with 'wiki_attach_url'.)
2. For each new source:
   a. Read the source file completely.
   b. Extract key concepts, entities, and facts. Search ('vault_search' / 'vault_rag_search') for existing pages before creating any.
   c. Write a summary page in 'wiki/sources/', then create or update pages in 'wiki/entities/' and 'wiki/concepts/' that meet the AGENTS.md page thresholds. Read a page in full before editing it and merge — never rewrite from memory. Use the templates in 'templates/'.
   d. Frontmatter: title, type, aliases, tags, sources, created, updated (bump on edit). Note contradictions per AGENTS.md — never silently overwrite.
   e. Link pages together following the wikilink rules below; update the relevant MOC.
3. Run 'wiki_index_rebuild' when finished.
4. Log it with 'wiki_log_append' ("ingest | Source Title — files changed"), then run 'wiki_sync'.

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

${RULEBOOK_STEP}

Follow this playbook:
1. Read 'wiki/index.md', then search with 'vault_rag_search' (meaning) and 'vault_search' (exact terms).
2. Use 'wiki_link_graph' to find related pages and context.
3. Read the relevant pages in full ('vault_batch_read' for small ones; finish any truncated page with 'vault_read' and offset=next_offset).
4. Synthesize an answer that:
   - Is grounded strictly in the wiki content.
   - Cites original pages with wikilinks (see rules below).
   - Identifies any gaps in knowledge where the wiki doesn't have the answer.
5. If the answer is a valuable comparison or analysis, offer to save it to 'wiki/synthesis/' (then rebuild the index and log it).

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

${RULEBOOK_STEP}

Follow this playbook:
1. Run 'wiki_lint_scan' to find issues (broken/ambiguous links, orphans, missing frontmatter, oversized pages).
2. Run 'wiki_lint_fix' with dry_run=true to preview the mechanical fixes (frontmatter scaffolding, index drift, unambiguous link normalization), then dry_run=false to apply them.
3. For remaining broken links: find the correct target (link by filename slug — see rules below) or mark them as TODO. Leave ambiguous links for human review.
4. For orphan pages: find relevant pages to link them from.
5. Split any 'oversized' page into topic sub-pages (AGENTS.md Rule 12).
6. Look for contradictions between pages and list pages marked 'contested: true' or 'confidence: low'.
7. Report a summary grouped by severity, log it with 'wiki_log_append' ("lint | ..."), and run 'wiki_sync' if you changed anything.

${WIKILINK_RULES}`,
          },
        },
      ],
    })
  );
}
