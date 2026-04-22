# second-brain-mcp

A remote **Model Context Protocol (MCP)** server that exposes a personal LLM-Wiki second brain — an Obsidian vault maintained by an LLM librarian — over the public internet via a Cloudflare Tunnel. No inbound ports, no VPN.

Based on the LLM-Wiki pattern from [Andrej Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) and the skills in [NicholasSpisak/second-brain](https://github.com/NicholasSpisak/second-brain), plus architectural borrowings from [jimprosser/obsidian-web-mcp](https://github.com/jimprosser/obsidian-web-mcp).

## What it does

- **Vault primitives** — read, write, list, search, move, soft-delete files in the vault, with path-traversal safety and atomic writes safe for Obsidian Sync.
- **Wiki bookkeeping tools** — scaffold a fresh vault, rebuild the master index, append to the log, find unprocessed raw sources, scan for lint issues, return backlink graphs, show recent git diffs.
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

## Quick start (remote, Cloudflare Tunnel)

See [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) for the end-to-end walkthrough. The short version:

1. On the vault machine, install Docker + `cloudflared`.
2. In the Cloudflare Zero Trust dashboard, create a Tunnel, pick a public hostname (e.g. `vault.cherrybrooknetworks.dev`), route it to `http://mcp:8787`, and copy the tunnel token.
3. Create a Cloudflare Access application for that hostname (email-gated is easiest). Note the Application Audience (AUD) tag.
4. Fill in `.env` next to `docker-compose.yml` with `VAULT_PATH`, `AUTH_TOKEN`, `CF_TUNNEL_TOKEN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
5. `docker compose up -d`.
6. Add the server to your MCP client (see [docs/clients.md](docs/clients.md)).

## Tools exposed

| Tool | Purpose |
|---|---|
| `vault_read` | Read a file; return body + parsed frontmatter |
| `vault_batch_read` | Read many files, one round-trip |
| `vault_write` | Atomic write with optional frontmatter merge, optional auto-commit |
| `vault_list` | Directory listing with depth + glob filter |
| `vault_search` | Full-text search (ripgrep with Node fallback) |
| `vault_search_frontmatter` | Query in-memory frontmatter index by field |
| `vault_move` | Rename / relocate within the vault |
| `vault_delete` | Soft-delete to `.trash/` |
| `vault_frontmatter_update` | Merge frontmatter on one or many files |
| `wiki_scaffold` | Create the LLM-Wiki directory structure + starter files |
| `wiki_index_rebuild` | Rebuild `wiki/index.md` from filesystem state |
| `wiki_log_append` | Append a dated entry to `wiki/log.md` |
| `wiki_link_graph` | Return backlinks + outlinks for a page (neighborhood) |
| `wiki_lint_scan` | Read-only health scan: broken links, orphans, index drift, missing pages |
| `wiki_unprocessed_sources` | List files in `raw/` that haven't been ingested yet |
| `wiki_diff` | Recent vault changes over a time window (git-backed) |
| `wiki_capture` | Quick-capture a snippet into `raw/inbox/` |
| `wiki_attach_url` | Fetch a URL and save as a raw source |
| `wiki_git_status` | Report vault git status (branch, dirty, ahead/behind) |

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

MIT — do whatever, no warranty.
