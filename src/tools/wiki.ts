import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RAW_DIR,
  WIKI_DIR,
  OUTPUT_DIR,
  WIKI_SUBDIRS,
  INDEX_FILE,
  LOG_FILE,
} from "../constants.js";
import { listDir, writeTextAtomic, exists, readText } from "../vault/fs.js";
import { buildMarkdown, parseMarkdown } from "../vault/frontmatter.js";
import { scanWikiPages } from "../vault/links.js";
import { gitStatus, gitLog } from "../vault/git.js";

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

        pages.sort((a, b) => a.path.localeCompare(b.path));

        let body = "# Wiki Index\n\n";
        const types = [...new Set(pages.map(p => p.type))].sort();

        for (const t of types) {
          body += `## ${t.charAt(0).toUpperCase() + t.slice(1)}\n`;
          const filtered = pages.filter(p => p.type === t);
          for (const p of filtered) {
            body += `- [[${p.path}|${p.title}]]\n`;
          }
          body += "\n";
        }

        const indexContent = buildMarkdown(
          { type: "index", title: "Wiki Index", updated: new Date().toISOString(), count: pages.length },
          body
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
      description: "Identifies broken links, orphan pages, and missing pages.",
      inputSchema: {},
    },
    async () => {
      try {
        const index = await scanWikiPages(cfg.VAULT_ROOT);
        const issues: { type: string, page: string, detail: string }[] = [];

        const validTitles = new Set(index.pages.map((p: any) => p.title.toLowerCase()));
        const validSlugs = new Set(index.pages.map((p: any) => p.slug.toLowerCase()));
        const validPaths = new Set(index.pages.map((p: any) => p.relPath.toLowerCase()));

        for (const p of index.pages) {
          // Check for orphans
          const bls = index.backlinks.get(p.title.toLowerCase()) ?? [];
          if (bls.length === 0) {
            issues.push({ type: "orphan", page: p.relPath, detail: "No pages link to this page." });
          }

          // Check outlinks
          for (const target of p.outlinks) {
            const tLower = target.toLowerCase();
            if (!validTitles.has(tLower) && !validSlugs.has(tLower) && !validPaths.has(tLower) && !target.startsWith("http")) {
              issues.push({ type: "broken-link", page: p.relPath, detail: `Links to "${target}" which does not exist.` });
            }
          }
        }

        return ok({ issueCount: issues.length, issues });
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
      description: "Fetches a URL's content and saves it into the raw/ directory.",
      inputSchema: {
        url: z.string().url().describe("The URL to fetch."),
        filename: z.string().optional().describe("Optional filename to save as."),
      },
    },
    async ({ url, filename }) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch URL: ${res.statusText}`);
        const body = await res.text();

        const root = cfg.VAULT_ROOT;
        const name = filename ?? `url-${Date.now()}.html`;
        const relPath = path.join(RAW_DIR, name);

        await writeTextAtomic(root, relPath, body, { createParents: true });
        return ok({ status: "success", path: relPath, bytes: body.length });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
