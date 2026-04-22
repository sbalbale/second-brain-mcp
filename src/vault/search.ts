import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { safeJoin, toVaultRel } from "./paths.js";

export interface SearchMatch {
  path: string; // vault-relative
  line: number;
  text: string;
}

/**
 * Full-text search using ripgrep if available, with a pure-Node fallback.
 * Query is treated as a literal string unless `regex: true`.
 */
export async function searchText(
  vaultRoot: string,
  query: string,
  opts: {
    regex?: boolean;
    caseSensitive?: boolean;
    path?: string; // vault-relative subtree to limit search to
    maxResults?: number;
    globs?: string[]; // optional ripgrep-style globs, e.g. ["*.md"]
  } = {},
): Promise<SearchMatch[]> {
  const subRel = opts.path && opts.path !== "" ? opts.path : ".";
  const subAbs = safeJoin(vaultRoot, subRel);
  const max = opts.maxResults ?? 200;

  const hasRg = await which("rg");
  if (hasRg) {
    return rgSearch(vaultRoot, subAbs, query, { ...opts, maxResults: max });
  }
  return nodeSearch(vaultRoot, subAbs, query, { ...opts, maxResults: max });
}

async function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

async function rgSearch(
  vaultRoot: string,
  subAbs: string,
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; maxResults: number; globs?: string[] },
): Promise<SearchMatch[]> {
  const args = [
    "--json",
    "--max-count",
    String(opts.maxResults),
    "--glob",
    "!.git",
    "--glob",
    "!.trash",
  ];
  if (!opts.regex) args.push("--fixed-strings");
  if (!opts.caseSensitive) args.push("--ignore-case");
  for (const g of opts.globs ?? []) args.push("--glob", g);
  args.push(query, subAbs);

  return new Promise<SearchMatch[]>((resolve) => {
    const child = spawn("rg", args);
    let buffer = "";
    const out: SearchMatch[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0 && out.length < opts.maxResults) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as RgEvent;
          if (ev.type === "match" && ev.data) {
            const absP = ev.data.path.text;
            out.push({
              path: toVaultRel(vaultRoot, absP),
              line: ev.data.line_number,
              text: ev.data.lines.text.replace(/\r?\n$/, ""),
            });
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
    child.on("close", () => resolve(out.slice(0, opts.maxResults)));
    child.on("error", () => resolve(out));
  });
}

interface RgEvent {
  type: string;
  data?: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

async function nodeSearch(
  vaultRoot: string,
  subAbs: string,
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; maxResults: number; globs?: string[] },
): Promise<SearchMatch[]> {
  const results: SearchMatch[] = [];
  const matcher = opts.regex
    ? new RegExp(query, opts.caseSensitive ? "" : "i")
    : null;
  const needle = opts.caseSensitive ? query : query.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (results.length >= opts.maxResults) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= opts.maxResults) return;
      const abs = path.join(dir, e.name);
      const rel = toVaultRel(vaultRoot, abs);
      if (rel.startsWith(".git/") || rel === ".git") continue;
      if (rel.startsWith(".trash/") || rel === ".trash") continue;
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        // Only text-ish files; skip obvious binaries by extension.
        if (!/\.(md|markdown|txt|mdx|org|json|ya?ml|html?)$/i.test(e.name)) continue;
        let text: string;
        try {
          text = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          const hit = matcher
            ? matcher.test(line)
            : opts.caseSensitive
              ? line.includes(needle)
              : line.toLowerCase().includes(needle);
          if (hit) {
            results.push({ path: rel, line: i + 1, text: line });
            if (results.length >= opts.maxResults) return;
          }
        }
      }
    }
  }
  await walk(subAbs);
  return results;
}
