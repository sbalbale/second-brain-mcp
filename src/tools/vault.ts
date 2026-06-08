import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import {
  exists,
  listDir,
  listTrash,
  moveInside,
  readText,
  restoreFromTrash,
  softDelete,
  writeTextAtomic,
} from "../vault/fs.js";
import { parseMarkdown, mergeFrontmatter, buildMarkdown } from "../vault/frontmatter.js";
import { searchText } from "../vault/search.js";
import { scanWikiPages, buildLinkResolver, buildBacklinksByPath, rewriteWikilinks } from "../vault/links.js";
import { maybeAutocommit as gitMaybeAutocommit, gitLog } from "../vault/git.js";
import { qmdQuery, readQmdIndexStatus, startQmdIndexing, startQmdUpdate } from "../vault/rag.js";
import { ResponseFormat, ResponseFormatSchema, VaultPath } from "../schemas/common.js";
import { CHARACTER_LIMIT, WIKI_DIR } from "../constants.js";
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

function maybeAutocommit(
  cfg: Config,
  message: string,
): Promise<{ committed: boolean; sha: string | null }> {
  return gitMaybeAutocommit(cfg.VAULT_AUTOCOMMIT, cfg.VAULT_ROOT, message);
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
        startQmdUpdate(cfg.VAULT_ROOT);
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

When 'relink' is true (default) and a single '.md' file is moved, inbound [[wikilinks]] across the vault are rewritten to point at the new location, preserving each link's style (#anchor and |alias kept; path-form links stay path-form, bare links stay bare). Bare basename links are only rewritten when the old basename was globally unique — otherwise they are left untouched, since Obsidian resolves ambiguous bare links by shortest-unique-path and rewriting could retarget the wrong note.

Args:
  - from (string): vault-relative source.
  - to (string): vault-relative destination.
  - create_parents (boolean): default true.
  - overwrite (boolean): default false.
  - relink (boolean): default true. Rewrite inbound wikilinks after a single-file .md move.

Returns:
  { "from", "to", "relinked_files", "relink_count", "committed", "sha" }`,
      inputSchema: {
        from: VaultPath,
        to: VaultPath,
        create_parents: z.boolean().default(true),
        overwrite: z.boolean().default(false),
        relink: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ from, to, create_parents, overwrite, relink }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const doRelink = relink && /\.md$/i.test(from);

        // Capture old-basename/title uniqueness BEFORE the move, while the old page still exists.
        let oldBasenameUnique = false;
        let oldTitle: string | undefined;
        let oldTitleUnique = false;
        if (doRelink) {
          const { pages } = await scanWikiPages(cfg.VAULT_ROOT);
          const oldSlug = path.basename(from, ".md").toLowerCase();
          oldBasenameUnique = pages.filter((p) => p.slug.toLowerCase() === oldSlug).length <= 1;
          const moved = pages.find((p) => p.relPath.toLowerCase() === from.toLowerCase());
          oldTitle = moved?.title;
          if (oldTitle) {
            const tl = oldTitle.toLowerCase();
            oldTitleUnique = pages.filter((p) => p.title.toLowerCase() === tl).length <= 1;
          }
        }

        const res = await moveInside(cfg.VAULT_ROOT, from, to, { createParents: create_parents, overwrite });

        const relinkedFiles: string[] = [];
        let relinkCount = 0;
        if (doRelink) {
          const oldSlug = path.basename(from, ".md");
          const newSlug = path.basename(to, ".md");
          const oldPathNoExt = from.replace(/\.md$/i, "");
          const newPathNoExt = to.replace(/\.md$/i, "");
          const replacer = (target: string): string | null => {
            const tl = target.trim().toLowerCase();
            if (tl === from.toLowerCase()) return to;                 // path-with-.md
            if (tl === oldPathNoExt.toLowerCase()) return newPathNoExt; // path-without-.md
            if (oldBasenameUnique && tl === oldSlug.toLowerCase()) return newSlug; // bare slug
            if (oldTitleUnique && oldTitle && tl === oldTitle.toLowerCase()) return newSlug; // bare title
            return null;
          };

          // Cheap candidate set: any .md file mentioning the old basename. rewriteWikilinks
          // matches targets exactly, so prose/prefix false-positives are written-back as no-ops.
          const matches = await searchText(cfg.VAULT_ROOT, oldSlug, { regex: false, caseSensitive: false, globs: ["*.md"], maxResults: 500 });
          const candidatePaths = [...new Set(matches.map((m) => m.path))];
          for (const cp of candidatePaths) {
            try {
              const text = await readText(cfg.VAULT_ROOT, cp);
              const { body: nextText, count } = rewriteWikilinks(text, replacer);
              if (count > 0) {
                await writeTextAtomic(cfg.VAULT_ROOT, cp, nextText, { createParents: false });
                relinkedFiles.push(cp);
                relinkCount += count;
              }
            } catch {
              // skip unreadable / racing files
            }
          }
        }

        const commit = await maybeAutocommit(cfg, `vault_move: ${from} -> ${to}`);
        return ok({ ...res, relinked_files: relinkedFiles, relink_count: relinkCount, ...commit });
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

  // ---- vault_restore ------------------------------------------------------
  server.registerTool(
    "vault_restore",
    {
      title: "List or restore soft-deleted files",
      description: `The inverse of vault_delete. Call with no 'path' to list restorable entries in .trash/ (most-recent first). Call with a trash 'path' to move it back to its original location.

Args:
  - path (string, optional): a trash entry path (as returned by the list mode). Omit to list.
  - overwrite (boolean): default false. Allow restoring over an existing file at the original path.

Returns (list): { count, entries: [{ trashPath, originalPath, deletedAt, type }] }
Returns (restore): { trashPath, restoredPath, committed, sha }`,
      inputSchema: {
        path: z.string().optional(),
        overwrite: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: rel, overwrite }) => {
      try {
        if (!rel) {
          const entries = await listTrash(cfg.VAULT_ROOT);
          return ok({ count: entries.length, entries });
        }
        if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
        const res = await restoreFromTrash(cfg.VAULT_ROOT, rel, { overwrite });
        const commit = await maybeAutocommit(cfg, `vault_restore: ${res.trashPath} -> ${res.restoredPath}`);
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
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
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

  // ---- vault_apply_template -----------------------------------------------
  server.registerTool(
    "vault_apply_template",
    {
      title: "Apply a template",
      description: `Reads a markdown template from the vault, substitutes {{variables}}, and writes it to a new file.

Args:
  - template_path (string): Vault-relative path to the template file.
  - destination_path (string): Vault-relative path for the new file.
  - variables (object): Key-value pairs for substitution. E.g., {"date": "2026-04-22"}.

Returns:
  { "path", "bytes", "committed", "sha" }`,
      inputSchema: {
        template_path: VaultPath,
        destination_path: VaultPath,
        variables: z.record(z.string()).default({}),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ template_path, destination_path, variables }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        let templateContent = await readText(cfg.VAULT_ROOT, template_path);
        
        // simple {{var}} substitution
        for (const [key, value] of Object.entries(variables)) {
          templateContent = templateContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }

        const res = await writeTextAtomic(cfg.VAULT_ROOT, destination_path, templateContent, { createParents: true });
        const commit = await maybeAutocommit(cfg, `vault_apply_template: ${template_path} -> ${destination_path}`);
        return ok({ path: res.relPath, bytes: res.bytes, ...commit });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_canvas_read --------------------------------------------------
  server.registerTool(
    "vault_canvas_read",
    {
      title: "Read an Obsidian Canvas",
      description: "Reads and parses an Obsidian .canvas file (JSON).",
      inputSchema: {
        path: VaultPath,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path: rel }) => {
      try {
        if (!rel.endsWith('.canvas')) return fail(new Error("Path must end with .canvas"));
        const text = await readText(cfg.VAULT_ROOT, rel);
        const canvas = JSON.parse(text);
        return ok({ path: rel, canvas });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_canvas_write -------------------------------------------------
  server.registerTool(
    "vault_canvas_write",
    {
      title: "Write an Obsidian Canvas",
      description: "Writes a valid Obsidian .canvas JSON structure to a file.",
      inputSchema: {
        path: VaultPath,
        canvas: z.object({
          nodes: z.array(z.object({}).passthrough()),
          edges: z.array(z.object({}).passthrough())
        }).passthrough(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ path: rel, canvas }) => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        if (!rel.endsWith('.canvas')) return fail(new Error("Path must end with .canvas"));
        const content = JSON.stringify(canvas, null, 2);
        const res = await writeTextAtomic(cfg.VAULT_ROOT, rel, content, { createParents: true });
        const commit = await maybeAutocommit(cfg, `vault_canvas_write: ${rel}`);
        return ok({ path: res.relPath, bytes: res.bytes, ...commit });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- vault_rag_index ----------------------------------------------------
  server.registerTool(
    "vault_rag_index",
    {
      title: "Index vault for semantic search",
      description: "Starts a background qmd update (BM25) + qmd embed (vector) job to fully index the vault. Uses local GGUF models via qmd — no API key required.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      if (cfg.READ_ONLY) return fail(new Error("Server is running in read-only mode."));
      try {
        const status = await startQmdIndexing(cfg.VAULT_ROOT);
        return ok({
          status: "started",
          provider: "qmd",
          jobId: status.jobId,
          phase: status.phase,
          statusFile: "output/qmd-index-status.json",
          message: "Indexing continues in the background; check output/qmd-index-status.json for progress and completion.",
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- vault_rag_status ---------------------------------------------------
  server.registerTool(
    "vault_rag_status",
    {
      title: "Read semantic index job status",
      description: "Returns the current qmd indexing job status from output/qmd-index-status.json, including the last known phase and completion state.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const status = await readQmdIndexStatus(cfg.VAULT_ROOT);
        return ok({
          found: status !== null,
          status,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- vault_rag_search ---------------------------------------------------
  server.registerTool(
    "vault_rag_search",
    {
      title: "Semantic search (RAG)",
      description: "Search the vault using qmd hybrid search (BM25 + vector + reranking). Uses local GGUF models — no API key required.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const results = qmdQuery(query, limit);
        return ok({
          count: results.length,
          results: results.map(r => ({ path: r.displayPath, score: r.score, snippet: r.snippet, title: r.title })),
          provider: "qmd",
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---- vault_stats --------------------------------------------------------
  server.registerTool(
    "vault_stats",
    {
      title: "Vault statistics dashboard",
      description: `Aggregate stats over the wiki: note count, total word count, outlink count, link density (outlinks/note), and orphan count/ratio. Orphans are non-root pages with no resolved inbound links (index.md and log.md are excluded by construction). Also reports growth over a recent window from git history.

Note: word count reads every note body and is the slowest part of this tool.

Args:
  - window_seconds (integer): growth window. Default 604800 (7 days). 0 = all history.

Returns:
  { "noteCount", "wordCount", "totalOutlinks", "linkDensity", "orphanCount", "orphanRatio", "orphans", "window": { "seconds", "commits", "filesTouched" } }`,
      inputSchema: {
        window_seconds: z.number().int().min(0).default(604800),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ window_seconds }) => {
      try {
        const index = await scanWikiPages(cfg.VAULT_ROOT);
        const resolver = buildLinkResolver(index.pages);
        const backlinks = buildBacklinksByPath(index.pages, resolver);

        const noteCount = index.pages.length;
        const totalOutlinks = index.pages.reduce((n, p) => n + p.outlinks.length, 0);
        const orphans = index.pages
          .filter((p) => (backlinks.get(p.relPath) ?? []).length === 0)
          .map((p) => p.relPath);

        let wordCount = 0;
        for (const p of index.pages) {
          try {
            const { body } = parseMarkdown(await readText(cfg.VAULT_ROOT, p.relPath));
            wordCount += body.split(/\s+/).filter(Boolean).length;
          } catch {
            // skip unreadable files
          }
        }

        const commits = await gitLog(cfg.VAULT_ROOT, window_seconds, 1000);
        const filesTouched = new Set<string>();
        for (const c of commits) for (const f of c.files) filesTouched.add(f);

        const round2 = (n: number) => Math.round(n * 100) / 100;
        return ok({
          noteCount,
          wordCount,
          totalOutlinks,
          linkDensity: noteCount ? round2(totalOutlinks / noteCount) : 0,
          orphanCount: orphans.length,
          orphanRatio: noteCount ? round2(orphans.length / noteCount) : 0,
          orphans: orphans.slice(0, 50),
          window: { seconds: window_seconds, commits: commits.length, filesTouched: filesTouched.size },
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}

// Re-export helpers so wiki tools can reuse them.
export { scanWikiPages };
