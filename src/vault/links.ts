import fs from "node:fs/promises";
import path from "node:path";
import { toVaultRel } from "./paths.js";
import { parseMarkdown } from "./frontmatter.js";
import { WIKI_SUBDIRS } from "../constants.js";

/** Match Obsidian-style [[Wiki Links]], optionally with |display text or #anchor. */
const WIKILINK_RE = /\[\[([^\]\|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

export interface PageInfo {
  relPath: string; // vault-relative
  title: string; // title cased (from filename stem by default)
  slug: string; // filename stem
  category: "sources" | "entities" | "concepts" | "synthesis" | "other";
  outlinks: string[]; // wikilink targets as written
}

export interface WikiIndex {
  pages: PageInfo[];
  byTitle: Map<string, PageInfo>;
  bySlug: Map<string, PageInfo>;
  backlinks: Map<string, string[]>; // title -> pages that link to it
}

/**
 * Walk the `wiki/` subdirectories and build an in-memory graph of pages,
 * outgoing wikilinks, and backlinks.
 */
export async function scanWikiPages(vaultRoot: string): Promise<WikiIndex> {
  const wikiAbs = path.join(vaultRoot, "wiki");
  const pages: PageInfo[] = [];

  for (const subdir of WIKI_SUBDIRS) {
    const sub = path.join(wikiAbs, subdir);
    try {
      await collect(sub, subdir, vaultRoot, pages);
    } catch {
      // subdir may not exist yet — fine
    }
  }

  const byTitle = new Map<string, PageInfo>();
  const bySlug = new Map<string, PageInfo>();
  for (const p of pages) {
    byTitle.set(p.title.toLowerCase(), p);
    bySlug.set(p.slug.toLowerCase(), p);
  }

  const backlinks = new Map<string, string[]>();
  for (const p of pages) {
    for (const target of p.outlinks) {
      const key = target.toLowerCase();
      const arr = backlinks.get(key) ?? [];
      arr.push(p.relPath);
      backlinks.set(key, arr);
    }
  }

  return { pages, byTitle, bySlug, backlinks };
}

async function collect(
  dirAbs: string,
  category: PageInfo["category"],
  vaultRoot: string,
  out: PageInfo[],
): Promise<void> {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dirAbs, e.name);
    if (e.isDirectory()) {
      await collect(abs, category, vaultRoot, out);
      continue;
    }
    if (!e.isFile() || !/\.md$/i.test(e.name)) continue;
    const text = await fs.readFile(abs, "utf8");
    const parsed = parseMarkdown(text);
    const slug = e.name.replace(/\.md$/i, "");
    const title = extractTitle(parsed.body) ?? slugToTitle(slug);
    const outlinks = extractWikilinks(parsed.body);
    out.push({
      relPath: toVaultRel(vaultRoot, abs),
      title,
      slug,
      category,
      outlinks,
    });
  }
}

export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = (m[1] ?? "").trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function extractTitle(body: string): string | null {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  return m ? (m[1] ?? null) : null;
}

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
