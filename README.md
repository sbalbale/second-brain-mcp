# second-brain-mcp

A remote **Model Context Protocol (MCP)** server that exposes a personal LLM-Wiki second brain — an Obsidian vault maintained by an LLM librarian — over the public internet via a Cloudflare Tunnel. No inbound ports, no VPN.

Based on the LLM-Wiki pattern from [Andrej Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## What it does

- **Vault primitives** — read, write, list, search, move, soft-delete files in the vault, with path-traversal safety and atomic writes safe for Obsidian Sync. Moving a note rewrites inbound `[[wikilinks]]` so links never dangle.
- **Wiki bookkeeping tools** — scaffold a fresh vault, rebuild the master index, append to the log, find unprocessed raw sources, return backlink graphs, enumerate tags, list templates, and report vault statistics.
- **Wiki maintenance** — a read-only lint scan (broken / ambiguous links, orphans, missing frontmatter) paired with an apply tool that auto-fixes the mechanical subset, plus note-merging that relinks references to the survivor.
- **Git round-trip** — the vault is a git repo; push (`wiki_sync`), pull (`wiki_pull`, fast-forward-only by default with conflicts surfaced as data), status, per-file history, and time-windowed diffs.
- **Semantic search** — hybrid BM25 + vector search via [qmd](https://github.com/tobilu/qmd), running local GGUF models. No API key, no rate limits, no data leaving the server.
- **Wiki workflow prompts** — `wiki_init`, `wiki_ingest`, `wiki_query`, `wiki_lint`. These return the playbook text from the upstream SKILL.md files so any MCP-capable LLM client can execute the LLM-Wiki workflows using the tools above.
- **Remote access** — streamable HTTP transport, fronted by Cloudflare Tunnel + Cloudflare Access (OAuth). The vault machine opens no inbound ports.

## Layout

```
second-brain-mcp/
├── src/
│   ├── index.ts            # entrypoint; chooses HTTP or stdio transport
│   ├── server.ts           # McpServer construction, tool + prompt registration
│   ├── config.ts           # env parsing
│   ├── auth.ts             # bearer token + Cloudflare Access JWT verification
│   ├── vault/              # fs primitives, path safety, search, links, git
│   ├── tools/              # MCP tool implementations
│   └── prompts/            # MCP prompt (workflow) definitions
├── docs/
│   ├── deploy-cloudflare.md
│   ├── deploy-docker.md
│   └── clients.md
├── Dockerfile
├── docker-compose.yml      # mcp + cloudflared sidecar
└── .env.example
```

## Quick start (local, stdio)

```bash
cp .env.example .env        # then edit VAULT_ROOT
npm install
npm run dev                 # TRANSPORT=stdio for Claude Desktop local
```

For semantic search, install and initialise qmd once:

```bash
npm install -g @tobilu/qmd
qmd collection add /path/to/your/vault --name vault
qmd context add qmd://vault "your personal knowledge base description"
```

Then call `vault_rag_index` from your MCP client to build the initial index (downloads ~2 GB of models on first run). Use `vault_rag_status` to check whether the background job is still running or has finished.

## Quick start (remote, Cloudflare Tunnel)

See [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) for the end-to-end walkthrough. The short version:

1. On the vault machine, install Docker + `cloudflared`.
2. In the Cloudflare Zero Trust dashboard, create a Tunnel, pick a public hostname (e.g. `vault.yourdomain.com`), route it to `http://mcp:8787`, and copy the tunnel token.
3. Create a Cloudflare Access application for that hostname (email-gated is easiest). Note the Application Audience (AUD) tag.
4. Fill in `.env` next to `docker-compose.yml` with `VAULT_PATH`, `AUTH_TOKEN`, `CF_TUNNEL_TOKEN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
5. `docker compose up -d` — qmd is installed in the image and auto-configured on first start via the entrypoint script.
6. Call `vault_rag_index` from your MCP client once to build the initial index. It now starts a background job and writes progress to `output/qmd-index-status.json` so the request returns before Cloudflare's 120-second timeout; the first run still downloads ~2 GB of GGUF models into the `qmd-models` Docker volume.
7. Add the server to your MCP client (see [docs/clients.md](docs/clients.md)).

## Tools exposed

| Tool | Purpose |
|---|---|
| `vault_read` | Read a file; return body + parsed frontmatter |
| `vault_batch_read` | Read many files, one round-trip |
| `vault_write` | Atomic write with optional frontmatter merge, optional auto-commit |
| `vault_list` | Directory listing with depth + glob filter |
| `vault_search` | Full-text search (ripgrep with Node fallback) |
| `vault_search_frontmatter` | Query in-memory frontmatter index by field |
| `vault_move` | Rename / relocate within the vault; rewrites inbound `[[wikilinks]]` (opt out with `relink:false`) |
| `vault_delete` | Soft-delete to `.trash/` |
| `vault_frontmatter_update` | Merge frontmatter on one or many files |
| `vault_apply_template` | Instantiate a template file, substituting `{{variables}}` |
| `vault_canvas_read` | Read and parse an Obsidian `.canvas` (JSON) file |
| `vault_canvas_write` | Write a valid Obsidian `.canvas` JSON structure |
| `vault_stats` | Dashboard: note/word counts, link density, orphan ratio, growth over a window |
| `vault_rag_index` | Full re-index: starts a background `qmd update` (BM25) then `qmd embed` (vectors) job |
| `vault_rag_status` | Read the current qmd indexing job status |
| `vault_rag_search` | Hybrid semantic search (BM25 + vector + reranking) via local qmd |
| `wiki_scaffold` | Create the LLM-Wiki directory structure + starter files |
| `wiki_index_rebuild` | Rebuild `wiki/index.md` from filesystem state |
| `wiki_log_append` | Append a dated entry to `wiki/log.md` |
| `wiki_link_graph` | Return backlinks + outlinks for a page (neighborhood) |
| `wiki_lint_scan` | Read-only health scan: broken links, ambiguous links, orphans, missing frontmatter |
| `wiki_lint_fix` | Auto-fix the mechanical subset of the lint scan (frontmatter / index / links); `dry_run` by default |
| `wiki_validate_frontmatter` | Check a directory for files missing required frontmatter fields |
| `wiki_tags` | Enumerate all tags (frontmatter + inline `#tags`) with counts and pages |
| `wiki_template_list` | List templates under `templates/` with the `{{variables}}` each expects |
| `wiki_merge_notes` | Merge one note into another and relink inbound references to the survivor |
| `wiki_unprocessed_sources` | List files in `raw/` that haven't been ingested yet |
| `wiki_capture` | Quick-capture a snippet into `raw/inbox/` |
| `wiki_attach_url` | Fetch a URL and save as a raw source |
| `wiki_git_status` | Report vault git status (branch, dirty, ahead/behind) |
| `wiki_diff` | Recent vault changes over a time window (git-backed) |
| `wiki_file_history` | Per-file commit history (`git log --follow`); optionally show contents at a SHA |
| `wiki_sync` | Push local vault commits to the remote |
| `wiki_pull` | Pull from the remote (fast-forward-only by default; conflicts returned as data) |

## Prompts exposed

| Prompt | Purpose |
|---|---|
| `wiki_init` | Guided wizard to set up a fresh vault |
| `wiki_ingest` | Process raw sources into structured wiki pages |
| `wiki_query` | Answer a question against the wiki with `[[citations]]` |
| `wiki_lint` | Full health-check workflow and reporting |

## Security model

- **Path safety**: every tool rejects paths that escape `VAULT_ROOT` via `..`, symlinks, or absolute paths.
- **Atomic writes**: writes go to a sibling temp file and `rename()` into place — Obsidian Sync safe.
- **Soft delete**: deletes move to `.trash/<original-path>.<timestamp>` and are reversible.
- **Bearer token**: every request must carry `Authorization: Bearer <AUTH_TOKEN>`.
- **Cloudflare Access JWT**: when `CF_ACCESS_AUD` is set, requests must carry a valid `Cf-Access-Jwt-Assertion` header whose `aud` matches.
- **Bind address**: defaults to `127.0.0.1`; `cloudflared` reaches it on localhost.

## License

MIT — see [LICENSE](LICENSE)
