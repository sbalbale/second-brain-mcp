import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  exists,
  listDir,
  moveInside,
  readText,
  softDelete,
  writeTextAtomic,
} from "../vault/fs.js";
import { parseMarkdown, mergeFrontmatter, buildMarkdown } from "../vault/frontmatter.js";
import { searchText } from "../vault/search.js";
import { scanWikiPages } from "../vault/links.js";
import { gitCommitAll } from "../vault/git.js";
import { ResponseFormat, ResponseFormatSchema, VaultPath } from "../schemas/common.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { PathSafetyError } from "../vault/paths.js";

/** Shared helper: format a tool response with both text and structured content. */
function ok(structured: unknown, text?: string) {
  const textContent = text ?? JSON.stringify(structured, null, 2);
  const capped =
    textContent.length > CHARACTER_LIMIT
      ? textContent.slice(0, CHARACTER_LIMIT) +
        `\n\n[truncated at ${CHARACTER_LIMIT} chars — use a smaller scope]`
      : textContent;
  return {
    content: [{ type: "text" as const, text: capped }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(err: unknown, hint?: string) {
  const msg = err instanceof Error ? err.message : String(err);
  const full = hint ? `${msg}\n\nHint: ${hint}` : msg;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `Error: ${full}` }],
  };
}

function isPathError(err: unknown): err is PathSafetyError {
  return err instanceof Error && err.name === "PathSafetyError";
}

async function maybeAutocommit(
  cfg: Config,
  message: string,
): Promise<{ committed: boolean; sha: string | null }> {
  if (!cfg.VAULT_AUTOCOMMIT) return { committed: false, sha: null };
  const res = await gitCommitAll(cfg.VAULT_ROOT, message);
  return { committed: res.committed, sha: res.sha };
}

export function registerVaultTools(server: McpServer, cfg: Config): void {
  // ---- vault_read ---------------------------------------------------------
  server.registerTool(
    "vault_read",
    {
      title: "Read a vault file",
      description: `Read a single file from the vault and return its body, parsed YAML frontmatter, and basic metadata.

Args:
  - path (string): Vault-relative path (e.g. "wiki/concepts/llm-wiki.md").
  - response_format ('markdown' | 'json'): default 'markdown'.

Returns:
  {
    "path": string,
    "bytes": number,
    "frontmatter": object,
    "body": string,
    "hasFrontmatter": boolean
  }`,
      inputSchema: { path: VaultPath, response_format: ResponseFormatSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: rel, response_format }) => {
      try {
        const text = await readText(cfg.VAULT_ROOT, rel);
        const parsed = parseMarkdown(text);
        const out = {
          path: rel,
          bytes: Buffer.byteLength(text, "utf8"),
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          hasFrontmatter: parsed.hasFrontmatter,
        };
        if (response_format === ResponseFormat.MARKDOWN) {
          const fmPretty =
            out.hasFrontmatter && Object.keys(out.frontmatter).length > 0
              ? "```yaml\n" + JSON.stringify(out.frontmatter, null, 2) + "\n```\n\n"
              : "";
          return ok(out, `# ${rel}\n\n${fmPretty}${out.body}`);
        }
        return ok(out);
      } catch (err) {
        return fail(err, isPathError(err) ? "Path must stay inside VAULT_ROOT and cannot start with /." : undefined);
      }
    },
  );

  // ---- vault_batch_read ---------------------------------------------------
  server.registerTool(
    "vault_batch_read",
    {
      title: "Read multiple vault files",
      description: `Read many files in one round-trip. Failing reads are reported per-path instead of aborting the whole call.

Args:
  - paths (string[]): Up to 50 vault-relative paths.

Returns:
  { "results": [{ "path", "ok", "body"?, "frontmatter"?, "error"? }, ...] }`,
      inputSchema: {
        paths: z.array(VaultPath).min(1).max(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ paths }) => {
      const results = await Promise.all(
        paths.map(async (p) => {
          try {
            const text = await readText(cfg.VAULT_ROOT, p);
            const parsed = parseMarkdown(text);
            return { path: p, ok: true, frontmatter: parsed.frontmatter, body: parsed.body };
          } catch (err) {
            return { path: p, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return ok({ results });
    },
  );

  // ---- vault_write --------------------------------------------------------
  server.registerTool(
    "vault_write",
    {
      title: "Write a vault file (atomic)",
      description: `Atomic UTF-8 write. Creates parent directories by default. Optionally merges frontmatter into an existing file instead of replacing the whole file. Triggers an auto-commit if VAULT_AUTOCOMMIT is enabled.

Args:
  - path (string): Vault-relative path.
  - content (string): Full file content to write when mode is 'replace', or the body (without frontmatter) when mode is 'merge-frontmatter'.
  - frontmatter (object, optional): YAML frontmatter fields to set or merge.
  - mode ('replace' | 'merge-frontmatter'): default 'replace'. 'merge-frontmatter' reads the existing file, merges frontmatter (arrays dedupe+append), replaces the body with 'content' if provided, and writes atomically.
  - commit_message (string, optional): override the auto-commit message.

Returns:
  { "path", "bytes", "committed", "sha" }`,
      inputSchema: {
        path: VaultPath,
        content: z.string().default(""),
        frontmatter: z.record(z.any()).optional(),
        mode: z.enum(["replace", "merge-frontmatter"]).default("replace"),
        commit_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: rel, content, frontmatter, mode, commit_message }) => {
      try {
        let finalText: string;
        if (mode === "merge-frontmatter") {
          let existing = "";
          if (await exists(cfg.VAULT_ROOT, rel)) {
            existing = await readText(cfg.VAULT_ROOT, rel);
          }
          if (frontmatter) {
            finalText = mergeFrontmatter(existing, frontmatter);
          } else {
            finalText = existing;
          }
          if (content && content.length > 0) {
            // replace body while preserving merged frontmatter
            const parsed = parseMarkdown(finalText);
            finalText = buildMarkdown(parsed.frontmatter, content);
          }
        } else {
          finalText = frontmatter ? buildMarkdown(frontmatter, content) : content;
        }
        const res = await writeTextAtomic(cfg.VAULT_ROOT, rel, finalText, { createParents: true });
        const commit = await maybeAutocommit(cfg, commit_message ?? `vault_write: ${rel}`);
        return ok({ path: res.relPath, bytes: res.bytes, ...commit });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_list ---------------------------------------------------------
  server.registerTool(
    "vault_list",
    {
      title: "List vault directory",
      description: `Directory listing with optional recursion and glob filter. Skips .git/ and .trash/ by default.

Args:
  - path (string): Vault-relative directory path. Use "." for vault root.
  - depth (integer 0-10): recurse this many levels. 0 = just the named dir.
  - glob (string, optional): glob filter against vault-relative posix path (e.g. "wiki/**/*.md").
  - include_dirs (boolean): default true.

Returns:
  { "count": number, "entries": [{ "path", "type", "size"?, "modified"? }, ...] }`,
      inputSchema: {
        path: z.string().default("."),
        depth: z.number().int().min(0).max(10).default(0),
        glob: z.string().optional(),
        include_dirs: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: rel, depth, glob, include_dirs }) => {
      try {
        const entries = await listDir(cfg.VAULT_ROOT, rel, { depth, globFilter: glob, includeDirs: include_dirs });
        return ok({ count: entries.length, entries });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_search -------------------------------------------------------
  server.registerTool(
    "vault_search",
    {
      title: "Full-text search the vault",
      description: `Search file contents. Uses ripgrep if available, with a Node fallback. Query is literal by default; set regex=true to treat it as a regex.

Args:
  - query (string): search string.
  - regex (boolean): default false.
  - case_sensitive (boolean): default false.
  - path (string, optional): limit search to a vault subtree.
  - globs (string[], optional): ripgrep-style glob filters, e.g. ["*.md"].
  - max_results (integer 1-500): default 100.

Returns:
  { "count": number, "matches": [{ "path", "line", "text" }, ...] }`,
      inputSchema: {
        query: z.string().min(1),
        regex: z.boolean().default(false),
        case_sensitive: z.boolean().default(false),
        path: z.string().optional(),
        globs: z.array(z.string()).optional(),
        max_results: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, regex, case_sensitive, path: rel, globs, max_results }) => {
      try {
        const matches = await searchText(cfg.VAULT_ROOT, query, {
          regex, caseSensitive: case_sensitive, path: rel, globs, maxResults: max_results,
        });
        return ok({ count: matches.length, matches });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_search_frontmatter -------------------------------------------
  server.registerTool(
    "vault_search_frontmatter",
    {
      title: "Search by frontmatter field",
      description: `Find all markdown files whose YAML frontmatter matches a field predicate. Scans wiki/ by default; pass path to limit scope.

Args:
  - field (string): frontmatter key (e.g. "tags", "sources").
  - predicate ('exists' | 'equals' | 'contains'): default 'exists'.
  - value (string | number | boolean, optional): value to match for 'equals'/'contains'. For array fields, 'contains' tests membership.
  - path (string, optional): limit to this subtree (default "wiki").

Returns:
  { "count": number, "files": [{ "path", "value" }, ...] }`,
      inputSchema: {
        field: z.string().min(1),
        predicate: z.enum(["exists", "equals", "contains"]).default("exists"),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        path: z.string().default("wiki"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ field, predicate, value, path: rel }) => {
      try {
        const entries = await listDir(cfg.VAULT_ROOT, rel, { depth: 10, globFilter: `${rel === "." ? "" : rel + "/"}**/*.md`, includeDirs: false });
        const matches: { path: string; value: unknown }[] = [];
        for (const e of entries) {
          try {
            const text = await readText(cfg.VAULT_ROOT, e.path);
            const parsed = parseMarkdown(text);
            if (!(field in parsed.frontmatter)) continue;
            const fieldValue = parsed.frontmatter[field];
            if (predicate === "exists") {
              matches.push({ path: e.path, value: fieldValue });
            } else if (predicate === "equals") {
              if (fieldValue === value) matches.push({ path: e.path, value: fieldValue });
            } else if (predicate === "contains") {
              if (Array.isArray(fieldValue) && fieldValue.includes(value as never)) {
                matches.push({ path: e.path, value: fieldValue });
              } else if (typeof fieldValue === "string" && typeof value === "string" && fieldValue.includes(value)) {
                matches.push({ path: e.path, value: fieldValue });
              }
            }
          } catch {
            // skip unreadable files
          }
        }
        return ok({ count: matches.length, files: matches });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_move ---------------------------------------------------------
  server.registerTool(
    "vault_move",
    {
      title: "Move / rename a vault file or directory",
      description: `Rename or relocate a file or directory inside the vault. Both source and destination must resolve inside VAULT_ROOT.

Args:
  - from (string): vault-relative source.
  - to (string): vault-relative destination.
  - create_parents (boolean): default true.
  - overwrite (boolean): default false.

Returns:
  { "from", "to", "committed", "sha" }`,
      inputSchema: {
        from: VaultPath,
        to: VaultPath,
        create_parents: z.boolean().default(true),
        overwrite: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to, create_parents, overwrite }) => {
      try {
        const res = await moveInside(cfg.VAULT_ROOT, from, to, { createParents: create_parents, overwrite });
        const commit = await maybeAutocommit(cfg, `vault_move: ${from} -> ${to}`);
        return ok({ ...res, ...commit });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_delete -------------------------------------------------------
  server.registerTool(
    "vault_delete",
    {
      title: "Soft-delete (move to .trash/)",
      description: `Soft delete: moves the path into .trash/<path>.<timestamp>. Fully reversible with a host-side 'mv'. Requires confirm=true to actually run.

Args:
  - path (string): vault-relative path to delete.
  - confirm (boolean): must be true. Guards against accidental destructive calls.

Returns:
  { "originalPath", "trashPath", "committed", "sha" }`,
      inputSchema: {
        path: VaultPath,
        confirm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: rel, confirm }) => {
      if (!confirm) return fail(new Error("Refusing to delete without confirm=true."));
      try {
        const res = await softDelete(cfg.VAULT_ROOT, rel);
        const commit = await maybeAutocommit(cfg, `vault_delete: ${rel} -> ${res.trashPath}`);
        return ok({ ...res, ...commit });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_frontmatter_update ------------------------------------------
  server.registerTool(
    "vault_frontmatter_update",
    {
      title: "Merge frontmatter across one or many files",
      description: `Merge YAML frontmatter fields into one or many files without touching the body. Arrays are deduplicated and appended (useful for accumulating 'sources:' or 'tags:').

Args:
  - paths (string[]): files to update.
  - updates (object): frontmatter keys → values to merge.
  - array_strategy ('append-unique' | 'replace'): default 'append-unique'.

Returns:
  { "updated": number, "files": [{ "path", "ok", "error"? }], "committed", "sha" }`,
      inputSchema: {
        paths: z.array(VaultPath).min(1).max(100),
        updates: z.record(z.any()),
        array_strategy: z.enum(["append-unique", "replace"]).default("append-unique"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ paths, updates, array_strategy }) => {
      const report: { path: string; ok: boolean; error?: string }[] = [];
      let updated = 0;
      for (const p of paths) {
        try {
          const existing = await readText(cfg.VAULT_ROOT, p);
          const next = mergeFrontmatter(existing, updates, { arrayStrategy: array_strategy });
          await writeTextAtomic(cfg.VAULT_ROOT, p, next, { createParents: false });
          report.push({ path: p, ok: true });
          updated++;
        } catch (err) {
          report.push({ path: p, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      const commit = await maybeAutocommit(cfg, `vault_frontmatter_update: ${updated} file(s)`);
      return ok({ updated, files: report, ...commit });
    },
  );
}

// Re-export helpers so wiki tools can reuse them.
export { scanWikiPages };
