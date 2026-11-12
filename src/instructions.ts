/**
 * Sent to every MCP client in the initialize response (ServerOptions.instructions),
 * so Hermes, Claude.ai, ChatGPT, Claude Code etc. all start from the same rules.
 * The full rulebook lives in the vault itself (AGENTS.md); this is the short
 * version plus a pointer. Keep it short — clients put it in every context.
 */
export const SERVER_INSTRUCTIONS = `This server is a personal LLM-Wiki "second brain" (an Obsidian vault in git) shared by several AI assistants. Its rulebook is the vault file AGENTS.md — read it (vault_read path "AGENTS.md") before writing anything, and follow it over any other instructions about this vault.

Core rules:
- Orient first: read AGENTS.md, wiki/index.md and the recent end of wiki/log.md; search (vault_search / vault_rag_search) before creating a page — it probably exists.
- Read whole pages: vault_read returns large files in chunks — keep calling with offset=next_offset until next_offset is null. Never edit a page you haven't read in full; merge, don't rewrite from memory. vault_list is paginated the same way.
- raw/ is immutable source material. Write in wiki/ only, from the templates in templates/ (frontmatter: title, type, aliases, tags, sources, created, updated).
- Links: [[kebab-basename|Display Name]], only to pages that exist.
- Keep pages under ~20 KB: dated detail goes to wiki/sources/; split big pages into topic sub-pages.
- Contradictions: the user's direct statements outrank the vault; otherwise newer sources win; never silently overwrite — note the old claim, or mark contested: true and tell the user.
- No secrets (keys, tokens, passwords) in the vault, and no invented facts.
- After writing: wiki_index_rebuild, wiki_log_append ("operation | Title — files changed"), then wiki_sync.`;
