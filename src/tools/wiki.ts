import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import fs from "node:fs/promises";
import path from "node:path";
import TurndownService from "turndown";
import { JSDOM } from "jsdom";
import {
  RAW_DIR,
  WIKI_DIR,
  OUTPUT_DIR,
  WIKI_SUBDIRS,
  INDEX_FILE,
  LOG_FILE,
} from "../constants.js";
import { listDir, writeTextAtomic, exists, readText, softDelete } from "../vault/fs.js";
import { searchText } from "../vault/search.js";
import { buildMarkdown, parseMarkdown, mergeFrontmatter, mergeFrontmatterIntoWins } from "../vault/frontmatter.js";
import { scanWikiPages, buildLinkResolver, buildBacklinksByPath, rewriteWikilinks } from "../vault/links.js";
import {
  scanLint,
  resolveBrokenLink,
  extractInlineTags,
  extractTemplateVars,
  formatIndexBody,
  categoryToType,
} from "../vault/maintenance.js";
import {
  gitStatus,
  gitLog,
  gitPush,
  gitUpstream,
  gitFetch,
  gitDirtyFiles,
  gitAheadBehind,
  gitHeadSha,
  gitChangedBetween,
  gitPull,
  gitFileHistory,
  gitShowFile,
  maybeAutocommit as gitMaybeAutocommit,
} from "../vault/git.js";

function ok(structured: unknown, text?: string) {
  const textContent = text ?? JSON.stringify(structured, null, 2);
  return {
    content: [{ type: "text" as const, text: textContent }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

function maybeAutocommit(cfg: Config, message: string) {
  return gitMaybeAutocommit(cfg.VAULT_AUTOCOMMIT, cfg.VAULT_ROOT, message);
}

export function registerWikiTools(server: McpServer, cfg: Config): void {
  // ---- wiki_scaffold ------------------------------------------------------
  server.registerTool(
    "wiki_scaffold",
    {
      title: "Scaffold a new LLM-Wiki vault",
      description: "Creates the standard directory structure (wiki/, raw/, output/) and starter files (index.md, log.md) if they don't exist.",
      inputSchema: {},
    },
    async () => {
      try {
        const root = cfg.VAULT_ROOT;
        const dirs = [
          RAW_DIR,
          WIKI_DIR,
          OUTPUT_DIR,
          ...WIKI_SUBDIRS.map(s => path.join(WIKI_DIR, s))
        ];

        for (const d of dirs) {
          await fs.mkdir(path.join(root, d), { recursive: true });
        }

        if (!(await exists(root, INDEX_FILE))) {
          const indexContent = buildMarkdown(
            { type: "index", title: "Wiki Index", created: new Date().toISOString() },
            "# Wiki Index\n\nWelcome to your second brain."
          );
          await writeTextAtomic(root, INDEX_FILE, indexContent);
        }

        if (!(await exists(root, LOG_FILE))) {
          const logContent = buildMarkdown(
            { type: "log", title: "Wiki Log" },
            "# Wiki Log\n\n## " + new Date().toISOString().split('T')[0] + "\n- Vault scaffolded."
          );
          await writeTextAtomic(root, LOG_FILE, logContent);
        }

        return ok({ status: "success", directories: dirs });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_index_rebuild -------------------------------------------------
  server.registerTool(
    "wiki_index_rebuild",
    {
      title: "Rebuild the wiki index",
      description: "Scans the wiki/ directory and updates wiki/index.md with a flat list of all pages and their types.",
      inputSchema: {},
    },
    async () => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const root = cfg.VAULT_ROOT;
        const entries = await listDir(root, WIKI_DIR, { depth: 5, includeDirs: false });

        const pages: { path: string, title: string, type: string }[] = [];
        for (const entry of entries) {
          if (entry.path === INDEX_FILE || !entry.path.endsWith(".md")) continue;

          try {
            const text = await readText(root, entry.path);
            const { frontmatter } = parseMarkdown(text);
            pages.push({
              path: entry.path,
              title: (frontmatter.title as string) ?? path.basename(entry.path, ".md"),
              type: (frontmatter.type as string) ?? "unknown"
            });
          } catch {
            // skip
          }
        }

        const indexContent = buildMarkdown(
          { type: "index", title: "Wiki Index", updated: new Date().toISOString(), count: pages.length },
          formatIndexBody(pages)
        );

        await writeTextAtomic(root, INDEX_FILE, indexContent);
        return ok({ status: "success", pageCount: pages.length });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_log_append ----------------------------------------------------
  server.registerTool(
    "wiki_log_append",
    {
      title: "Append to the wiki log",
      description: "Adds a new dated entry to wiki/log.md. Useful for tracking what the LLM has done in a session.",
      inputSchema: {
        entry: z.string().min(1).describe("The log message to append."),
      },
    },
    async ({ entry }) => {
      try {
        const root = cfg.VAULT_ROOT;
        let content = "";
        if (await exists(root, LOG_FILE)) {
          content = await readText(root, LOG_FILE);
        } else {
          content = buildMarkdown({ type: "log", title: "Wiki Log" }, "# Wiki Log\n");
        }

        const date = new Date().toISOString().split('T')[0];
        const entryText = `\n## ${date}\n- ${entry}\n`;

        // Simple append to the end of the file body
        const parsed = parseMarkdown(content);
        const nextBody = parsed.body.trimEnd() + "\n" + entryText;
        const nextContent = buildMarkdown(parsed.frontmatter, nextBody);

        await writeTextAtomic(root, LOG_FILE, nextContent);
        return ok({ status: "success", date });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_link_graph ----------------------------------------------------
  server.registerTool(
    "wiki_link_graph",
    {
      title: "Get wiki link graph",
      description: "Returns backlinks and outlinks for a specific page, or for all pages if no path is provided.",
      inputSchema: {
        path: z.string().optional().describe("Vault-relative path to a page."),
      },
    },
    async ({ path: rel }) => {
      try {
        const index = await scanWikiPages(cfg.VAULT_ROOT);
        if (rel) {
          const page = index.pages.find((p: any) => p.relPath === rel);
          if (!page) throw new Error(`Page not found: ${rel}`);
          const bls = index.backlinks.get(page.title.toLowerCase()) ?? [];
          return ok({ path: rel, title: page.title, outlinks: page.outlinks, backlinks: bls });
        }

        // Convert Map to record for JSON serialization
        const blsRecord: Record<string, string[]> = {};
        for (const [k, v] of index.backlinks) blsRecord[k] = v;

        return ok({ pages: index.pages, backlinks: blsRecord });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_lint_scan -----------------------------------------------------
  server.registerTool(
    "wiki_lint_scan",
    {
      title: "Scan wiki for health issues",
      description: `Identifies orphan pages, broken links, ambiguous links (a bare target matching more than one note), and pages missing required frontmatter. Read-only — see wiki_lint_fix to apply the mechanical subset.

Args:
  - required_fields (string[]): frontmatter keys every page must have. Default ["type","title"].

Returns:
  { "issueCount", "byType": { ... }, "issues": [structured LintIssue, ...] }`,
      inputSchema: {
        required_fields: z.array(z.string()).default(["type", "title"]),
      },
    },
    async ({ required_fields }) => {
      try {
        const index = await scanWikiPages(cfg.VAULT_ROOT);
        const resolver = buildLinkResolver(index.pages);
        const backlinks = buildBacklinksByPath(index.pages, resolver);
        const issues = scanLint(index.pages, resolver, backlinks, required_fields);
        const byType: Record<string, number> = {};
        for (const i of issues) byType[i.type] = (byType[i.type] ?? 0) + 1;
        return ok({ issueCount: issues.length, byType, issues });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_unprocessed_sources -------------------------------------------
  server.registerTool(
    "wiki_unprocessed_sources",
    {
      title: "List unprocessed sources",
      description: `List all files in the raw/ directory that haven't been ingested into the wiki yet.`,
      inputSchema: {},
    },
    async () => {
      try {
        const root = cfg.VAULT_ROOT;
        const entries = await listDir(root, RAW_DIR, { depth: 10, includeDirs: false });
        return ok({ count: entries.length, sources: entries });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_git_status ----------------------------------------------------
  server.registerTool(
    "wiki_git_status",
    {
      title: "Report vault git status",
      description: "Shows if the vault is a git repo, current branch, dirty state, and ahead/behind counts.",
      inputSchema: {},
    },
    async () => {
      try {
        const status = await gitStatus(cfg.VAULT_ROOT);
        return ok(status);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_diff ----------------------------------------------------------
  server.registerTool(
    "wiki_diff",
    {
      title: "Recent vault changes",
      description: "Returns a list of files changed in the vault over a time window using git history.",
      inputSchema: {
        since_seconds: z.number().int().min(0).default(3600).describe("Look back this many seconds. 0 for all."),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async ({ since_seconds, limit }) => {
      try {
        const commits = await gitLog(cfg.VAULT_ROOT, since_seconds, limit);
        return ok({ count: commits.length, commits });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_capture -------------------------------------------------------
  server.registerTool(
    "wiki_capture",
    {
      title: "Capture a snippet to the inbox",
      description: "Quickly save a text snippet or note into raw/inbox/ for later processing.",
      inputSchema: {
        content: z.string().min(1).describe("The text to capture."),
        title: z.string().optional().describe("Optional title (used for filename)."),
      },
    },
    async ({ content, title }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const root = cfg.VAULT_ROOT;
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const name = title ? `${title.replace(/[^a-z0-9]/gi, "-")}-${ts}.md` : `capture-${ts}.md`;
        const relPath = path.join(RAW_DIR, "inbox", name);

        await writeTextAtomic(root, relPath, content, { createParents: true });
        return ok({ status: "success", path: relPath });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_attach_url ----------------------------------------------------
  server.registerTool(
    "wiki_attach_url",
    {
      title: "Attach a URL as a raw source",
      description: "Fetches a URL's content, converts it to Markdown, and saves it into the raw/ directory.",
      inputSchema: {
        url: z.string().url().describe("The URL to fetch."),
        filename: z.string().optional().describe("Optional filename to save as. Defaults to a slugified title or URL with a timestamp."),
      },
    },
    async ({ url, filename }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch URL: ${res.statusText}`);
        const html = await res.text();

        const dom = new JSDOM(html);
        const title = dom.window.document.title || url.replace(/^https?:\/\//, '').split('/')[0] || "Untitled";
        
        const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        const markdownBody = turndownService.turndown(dom.window.document.body ? dom.window.document.body.innerHTML : html);

        const root = cfg.VAULT_ROOT;
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        
        // create a safe slug for the filename if not provided
        const safeTitle = title.replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
        const name = filename ?? `${safeTitle || 'url'}-${ts}.md`;
        const relPath = path.join(RAW_DIR, name);

        // Include frontmatter with the source URL
        const content = buildMarkdown(
          { type: "source", source: url, title, captured: new Date().toISOString() },
          markdownBody
        );

        await writeTextAtomic(root, relPath, content, { createParents: true });
        return ok({ status: "success", path: relPath, bytes: content.length, title });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_sync ----------------------------------------------------------
  server.registerTool(
    "wiki_sync",
    {
      title: "Sync vault to remote",
      description: "Runs git push to sync the local vault commits to the remote repository.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await gitPush(cfg.VAULT_ROOT);
        if (!result.success) return fail(new Error(`Git push failed: ${result.stderr}`));
        return ok({ status: "success", stdout: result.stdout });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_validate_frontmatter ------------------------------------------
  server.registerTool(
    "wiki_validate_frontmatter",
    {
      title: "Validate frontmatter schema",
      description: "Checks all markdown files in a directory to ensure they have the required frontmatter fields.",
      inputSchema: {
        path: z.string().default("wiki"),
        required_fields: z.array(z.string()).min(1).describe("List of required YAML keys (e.g. ['tags', 'sources'])."),
      },
    },
    async ({ path: rel, required_fields }) => {
      try {
        const root = cfg.VAULT_ROOT;
        const entries = await listDir(root, rel, { depth: 10, includeDirs: false });
        
        const invalidFiles: { path: string; missing: string[] }[] = [];
        
        for (const entry of entries) {
          if (!entry.path.endsWith(".md")) continue;
          try {
            const text = await readText(root, entry.path);
            const { frontmatter } = parseMarkdown(text);
            
            const missing = required_fields.filter(f => !(f in frontmatter));
            if (missing.length > 0) {
              invalidFiles.push({ path: entry.path, missing });
            }
          } catch {
            // ignore unreadable files
          }
        }
        
        return ok({
          status: invalidFiles.length === 0 ? "success" : "failed",
          scanned: entries.length,
          invalidCount: invalidFiles.length,
          invalidFiles
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_pull ----------------------------------------------------------
  server.registerTool(
    "wiki_pull",
    {
      title: "Pull vault from remote",
      description: `Pull remote commits into the local vault. Defaults to a fast-forward-only pull so the tool never invents a merge commit unattended; conflicts are reported as data, never auto-resolved.

Notes:
  - allow_dirty does NOT force anything: 'git pull --ff-only' still refuses when an incoming change overlaps a locally-modified tracked file. It only succeeds when the dirty set and the incoming changeset are disjoint.
  - The dirty check is a point-in-time gate with an inherent race (Obsidian Sync can write between the check and the pull). --ff-only is the real safety mechanism: it refuses anything needing a true merge, so the worst case is a clean failure, never a corrupt merge.
  - Pull over SSH uses the same key path as push; if it fails on permissions, re-apply the container key fix (chown -R 10001:10001 /home/docker/obsidian-ssh).

Args:
  - strategy ('ff-only' | 'rebase'): default 'ff-only'.
  - allow_dirty (boolean): default false. Skip the dirty-tree refusal (see note above).

Returns (on success): { pulled: true, files_changed, ahead, behind, sha }
Returns (no-op/refusal): { pulled: false, reason, dirty_files? | conflicts? | ahead, behind }`,
      inputSchema: {
        strategy: z.enum(["ff-only", "rebase"]).default("ff-only"),
        allow_dirty: z.boolean().default(false),
      },
    },
    async ({ strategy, allow_dirty }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const root = cfg.VAULT_ROOT;
        const status = await gitStatus(root);
        if (!status.isRepo) return fail(new Error("Vault is not a git repository."));

        if (!(await gitUpstream(root))) {
          return ok({ pulled: false, reason: "no upstream" });
        }

        if (status.dirty && !allow_dirty) {
          return ok({ pulled: false, reason: "dirty", dirty_files: await gitDirtyFiles(root) });
        }

        const fetched = await gitFetch(root);
        if (!fetched.success) return fail(new Error(`git fetch failed: ${fetched.stderr}`));

        const { ahead, behind } = await gitAheadBehind(root);
        if (behind === 0) return ok({ pulled: false, reason: "up to date", ahead, behind });

        const before = await gitHeadSha(root);
        const result = await gitPull(root, strategy);
        if (!result.success) {
          if (result.reason === "conflict") {
            return ok({ pulled: false, reason: "conflict", conflicts: result.conflicts ?? [] });
          }
          return ok({ pulled: false, reason: result.reason ?? "failed", detail: result.stderr });
        }

        const after = await gitHeadSha(root);
        const files_changed = before && after ? await gitChangedBetween(root, before, after) : [];
        return ok({ pulled: true, files_changed, ahead, behind, sha: after });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_lint_fix ------------------------------------------------------
  server.registerTool(
    "wiki_lint_fix",
    {
      title: "Auto-fix mechanical wiki lint issues",
      description: `Apply the mechanical subset of wiki_lint_scan: scaffold missing frontmatter (title/type), regenerate a drifted index, and normalize unambiguous broken links (format/punctuation variants of a real note). Orphans and ambiguous links are NEVER touched. All fixes for a file are applied in a single write, with one commit at the end.

Args:
  - dry_run (boolean): default true. Preview changes without writing.
  - fixes (string[]): subset of ["frontmatter","index","links"]. Default all three.
  - required_fields (string[]): frontmatter keys to scaffold. Default ["type","title"] (only title/type can be scaffolded mechanically; others are reported, not invented).

Returns:
  { dry_run, counts: { frontmatter, links, index }, changes: [{ file, class, before?, after? }] }`,
      inputSchema: {
        dry_run: z.boolean().default(true),
        fixes: z.array(z.enum(["frontmatter", "index", "links"])).default(["frontmatter", "index", "links"]),
        required_fields: z.array(z.string()).default(["type", "title"]),
      },
    },
    async ({ dry_run, fixes, required_fields }) => {
      if (!dry_run && cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const root = cfg.VAULT_ROOT;
        const index = await scanWikiPages(root);
        const resolver = buildLinkResolver(index.pages);
        const backlinks = buildBacklinksByPath(index.pages, resolver);
        const issues = scanLint(index.pages, resolver, backlinks, required_fields);

        const changes: { file: string; class: string; before?: unknown; after?: unknown }[] = [];
        const counts = { frontmatter: 0, links: 0, index: 0 };
        let wrote = false;

        // Group frontmatter + link fixes per file and apply in a single read/modify/write.
        const pageByPath = new Map(index.pages.map((p) => [p.relPath, p]));
        const fmByFile = new Map<string, Record<string, unknown>>();
        const linksByFile = new Map<string, Map<string, string>>();

        if (fixes.includes("frontmatter")) {
          for (const issue of issues) {
            if (issue.type !== "missing-frontmatter") continue;
            const page = pageByPath.get(issue.page);
            if (!page) continue;
            const updates: Record<string, unknown> = {};
            for (const f of issue.missing) {
              if (f === "title") updates.title = page.title;
              else if (f === "type") updates.type = categoryToType(page.category);
              // other required fields cannot be mechanically scaffolded — leave for human.
            }
            if (Object.keys(updates).length > 0) fmByFile.set(issue.page, updates);
          }
        }

        if (fixes.includes("links")) {
          for (const issue of issues) {
            if (issue.type !== "broken-link") continue;
            const canonical = resolveBrokenLink(issue.target, resolver);
            if (!canonical) continue;
            const m = linksByFile.get(issue.page) ?? new Map<string, string>();
            m.set(issue.target.trim().toLowerCase(), canonical);
            linksByFile.set(issue.page, m);
          }
        }

        const touchedFiles = new Set<string>([...fmByFile.keys(), ...linksByFile.keys()]);
        for (const file of touchedFiles) {
          try {
            const original = await readText(root, file);
            let text = original;
            const updates = fmByFile.get(file);
            if (updates) {
              text = mergeFrontmatter(text, updates);
              counts.frontmatter++;
              changes.push({ file, class: "frontmatter", after: updates });
            }
            const linkMap = linksByFile.get(file);
            if (linkMap) {
              const { body, count } = rewriteWikilinks(text, (t) => linkMap.get(t.trim().toLowerCase()) ?? null);
              if (count > 0) {
                text = body;
                counts.links += count;
                changes.push({ file, class: "links", after: Object.fromEntries(linkMap) });
              }
            }
            if (text !== original && !dry_run) {
              await writeTextAtomic(root, file, text, { createParents: false });
              wrote = true;
            }
          } catch {
            // skip unreadable / racing files
          }
        }

        // Index drift: compare generated body (ignoring the timestamp frontmatter) against current.
        if (fixes.includes("index")) {
          const entries = await listDir(root, WIKI_DIR, { depth: 5, includeDirs: false });
          const idxPages: { path: string; title: string; type: string }[] = [];
          for (const entry of entries) {
            if (entry.path === INDEX_FILE || !entry.path.endsWith(".md")) continue;
            try {
              const { frontmatter } = parseMarkdown(await readText(root, entry.path));
              idxPages.push({
                path: entry.path,
                title: (frontmatter.title as string) ?? path.basename(entry.path, ".md"),
                type: (frontmatter.type as string) ?? "unknown",
              });
            } catch {
              // skip
            }
          }
          const newBody = formatIndexBody(idxPages);
          let currentBody = "";
          if (await exists(root, INDEX_FILE)) {
            currentBody = parseMarkdown(await readText(root, INDEX_FILE)).body;
          }
          if (newBody.trim() !== currentBody.trim()) {
            counts.index++;
            changes.push({ file: INDEX_FILE, class: "index" });
            if (!dry_run) {
              const content = buildMarkdown(
                { type: "index", title: "Wiki Index", updated: new Date().toISOString(), count: idxPages.length },
                newBody,
              );
              await writeTextAtomic(root, INDEX_FILE, content);
              wrote = true;
            }
          }
        }

        let commit: { committed: boolean; sha: string | null } = { committed: false, sha: null };
        if (wrote) {
          const total = counts.frontmatter + counts.links + counts.index;
          commit = await maybeAutocommit(cfg, `wiki_lint_fix: ${total} fix(es)`);
        }
        return ok({ dry_run, counts, changes, ...commit });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_file_history --------------------------------------------------
  server.registerTool(
    "wiki_file_history",
    {
      title: "Per-file git history",
      description: `Show a single note's commit history (git log --follow), so renames are tracked. Optionally return the file's contents at a specific commit.

Args:
  - path (string): vault-relative path to the note.
  - limit (integer 1-200): max commits. Default 50.
  - sha (string, optional): if given, also return the file's contents at that commit.

Returns:
  { path, count, commits: [{ sha, date, subject }], contents_at_sha? }`,
      inputSchema: {
        path: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        sha: z.string().optional(),
      },
    },
    async ({ path: rel, limit, sha }) => {
      try {
        const commits = await gitFileHistory(cfg.VAULT_ROOT, rel, limit);
        const out: Record<string, unknown> = { path: rel, count: commits.length, commits };
        if (sha) out.contents_at_sha = await gitShowFile(cfg.VAULT_ROOT, sha, rel);
        return ok(out);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_tags ----------------------------------------------------------
  server.registerTool(
    "wiki_tags",
    {
      title: "Enumerate tags",
      description: `List all tags (frontmatter 'tags:' plus inline #tags) with their counts and the pages carrying each. Useful for spotting concept drift and near-duplicate tags.

Args:
  - path (string): subtree to scan. Default "wiki".

Returns:
  { tagCount, tags: [{ tag, count, pages: [...] }] } sorted by count descending.`,
      inputSchema: {
        path: z.string().default("wiki"),
      },
    },
    async ({ path: rel }) => {
      try {
        const root = cfg.VAULT_ROOT;
        const entries = await listDir(root, rel, { depth: 10, includeDirs: false });
        const agg = new Map<string, Set<string>>();
        const addTag = (raw: string, page: string) => {
          const tag = raw.replace(/^#/, "").trim();
          if (!tag) return;
          const set = agg.get(tag) ?? new Set<string>();
          set.add(page);
          agg.set(tag, set);
        };
        for (const entry of entries) {
          if (!entry.path.endsWith(".md")) continue;
          try {
            const text = await readText(root, entry.path);
            const { frontmatter, body } = parseMarkdown(text);
            const fmTags = frontmatter.tags;
            if (Array.isArray(fmTags)) for (const t of fmTags) addTag(String(t), entry.path);
            else if (typeof fmTags === "string") for (const t of fmTags.split(/[,\s]+/)) addTag(t, entry.path);
            for (const t of extractInlineTags(body)) addTag(t, entry.path);
          } catch {
            // skip unreadable files
          }
        }
        const tags = [...agg.entries()]
          .map(([tag, pages]) => ({ tag, count: pages.size, pages: [...pages].sort() }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return ok({ tagCount: tags.length, tags });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_template_list -------------------------------------------------
  server.registerTool(
    "wiki_template_list",
    {
      title: "List templates",
      description: `List markdown templates under templates/ at the vault root, with the {{variables}} each expects. Companion to vault_apply_template. Returns an empty list (not an error) if templates/ does not exist.

Returns:
  { count, templates: [{ path, name, variables: [...] }] }`,
      inputSchema: {},
    },
    async () => {
      try {
        const root = cfg.VAULT_ROOT;
        const dir = "templates";
        if (!(await exists(root, dir))) return ok({ count: 0, templates: [] });
        const entries = await listDir(root, dir, { depth: 5, includeDirs: false });
        const templates: { path: string; name: string; variables: string[] }[] = [];
        for (const entry of entries) {
          if (!entry.path.endsWith(".md")) continue;
          try {
            const content = await readText(root, entry.path);
            templates.push({
              path: entry.path,
              name: path.basename(entry.path, ".md"),
              variables: extractTemplateVars(content),
            });
          } catch {
            // skip unreadable files
          }
        }
        return ok({ count: templates.length, templates });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- wiki_merge_notes ---------------------------------------------------
  server.registerTool(
    "wiki_merge_notes",
    {
      title: "Merge two notes",
      description: `Combine 'from' into 'into': append from's body, union from's array frontmatter (into wins for scalars like title/created/type), relink inbound [[from]] references to the survivor, and soft-delete the source. Bare basename/title links are only rewritten when from's basename/title was globally unique (see vault_move).

Args:
  - from (string): note to merge away (the source).
  - into (string): surviving note.
  - separator (string): inserted between the two bodies. Default "\\n\\n---\\n\\n".
  - delete_source (boolean): soft-delete 'from' after merging. Default true.
  - relink (boolean): rewrite inbound [[from]] links to 'into'. Default true.
  - dry_run (boolean): preview without writing. Default false.

Refuses delete_source && !relink (would orphan every inbound link).

Returns:
  { from, into, dry_run, relinked_files, relink_count, deleted_source, committed, sha }`,
      inputSchema: {
        from: z.string().min(1),
        into: z.string().min(1),
        separator: z.string().default("\n\n---\n\n"),
        delete_source: z.boolean().default(true),
        relink: z.boolean().default(true),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ from, into, separator, delete_source, relink, dry_run }) => {
      if (!dry_run && cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      if (from === into) return fail(new Error("'from' and 'into' must differ."));
      if (delete_source && !relink) return fail(new Error("Refusing delete_source with relink=false: every inbound [[from]] link would break. Set relink=true or delete_source=false."));
      try {
        const root = cfg.VAULT_ROOT;
        const fromParsed = parseMarkdown(await readText(root, from));
        const intoText = await readText(root, into);
        const intoParsed = parseMarkdown(intoText);

        // Survivor body: into body + separator + from body. Frontmatter: into scalars win, arrays union.
        const mergedBody = intoParsed.body.trimEnd() + separator + fromParsed.body.trimStart();
        const mergedFm = parseMarkdown(mergeFrontmatterIntoWins(intoText, fromParsed.frontmatter)).frontmatter;
        let mergedFile = buildMarkdown(mergedFm, mergedBody);

        // Build a style-preserving, uniqueness-gated replacer for inbound [[from]] links.
        const { pages } = await scanWikiPages(root);
        const fromSlug = path.basename(from, ".md");
        const intoSlug = path.basename(into, ".md");
        const fromPathNoExt = from.replace(/\.md$/i, "");
        const intoPathNoExt = into.replace(/\.md$/i, "");
        const fromSlugUnique = pages.filter((p) => p.slug.toLowerCase() === fromSlug.toLowerCase()).length <= 1;
        const fromPage = pages.find((p) => p.relPath.toLowerCase() === from.toLowerCase());
        const fromTitle = fromPage?.title;
        const fromTitleUnique = fromTitle
          ? pages.filter((p) => p.title.toLowerCase() === fromTitle.toLowerCase()).length <= 1
          : false;
        const replacer = (target: string): string | null => {
          const tl = target.trim().toLowerCase();
          if (tl === from.toLowerCase()) return into;
          if (tl === fromPathNoExt.toLowerCase()) return intoPathNoExt;
          if (fromSlugUnique && tl === fromSlug.toLowerCase()) return intoSlug;
          if (fromTitleUnique && fromTitle && tl === fromTitle.toLowerCase()) return intoSlug;
          return null;
        };

        const relinkedFiles: string[] = [];
        let relinkCount = 0;
        if (relink) {
          // Fix any [[from]] references that live inside the survivor's own (merged) content.
          mergedFile = rewriteWikilinks(mergedFile, replacer).body;

          const matches = await searchText(root, fromSlug, { regex: false, caseSensitive: false, globs: ["*.md"], maxResults: 500 });
          const candidatePaths = [...new Set(matches.map((m) => m.path))].filter((p) => p !== from && p !== into);
          for (const cp of candidatePaths) {
            try {
              const text = await readText(root, cp);
              const { body, count } = rewriteWikilinks(text, replacer);
              if (count > 0) {
                if (!dry_run) await writeTextAtomic(root, cp, body, { createParents: false });
                relinkedFiles.push(cp);
                relinkCount += count;
              }
            } catch {
              // skip unreadable / racing files
            }
          }
        }

        let deletedSource = false;
        if (!dry_run) {
          await writeTextAtomic(root, into, mergedFile, { createParents: false });
          if (delete_source) {
            await softDelete(root, from);
            deletedSource = true;
          }
        }

        let commit: { committed: boolean; sha: string | null } = { committed: false, sha: null };
        if (!dry_run) commit = await maybeAutocommit(cfg, `wiki_merge_notes: ${from} -> ${into}`);

        return ok({
          from,
          into,
          dry_run,
          relinked_files: relinkedFiles,
          relink_count: relinkCount,
          deleted_source: deletedSource,
          ...commit,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
