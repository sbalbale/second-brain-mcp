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
  frontmatter: Record<string, unknown>; // parsed YAML frontmatter
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
      frontmatter: parsed.frontmatter,
    });
  }
}

/**
 * Capturing variant of the wikilink pattern: group 1 = target, group 2 = "#anchor"
 * (with leading #), group 3 = "|alias" (with leading |). Used for rewriting.
 */
const WIKILINK_CAPTURE_RE = /\[\[([^\[\]|#]+)(#[^\[\]|]+)?(\|[^\[\]]+)?\]\]/g;

/** Strip a wikilink target down to its bare form: no #anchor, no |alias, trimmed. */
function bareTarget(raw: string): string {
  return raw.split("#")[0]!.split("|")[0]!.trim();
}

export interface LinkResolver {
  /**
   * Resolve a raw wikilink target (any of title / slug / path-with-.md /
   * path-without-.md, case-insensitive) to a page. `candidates` preserves
   * ambiguity: multiple pages sharing a basename do not silently collapse.
   */
  resolve(rawTarget: string): { page: PageInfo | null; ambiguous: boolean; candidates: PageInfo[] };
}

/**
 * Build an ambiguity-preserving resolver over the four link forms. Each page is
 * registered under its lowercased title, slug, relPath, and relPath-without-.md.
 */
export function buildLinkResolver(pages: PageInfo[]): LinkResolver {
  const index = new Map<string, PageInfo[]>();
  const add = (key: string, page: PageInfo) => {
    const k = key.toLowerCase();
    if (!k) return;
    const arr = index.get(k) ?? [];
    if (!arr.includes(page)) arr.push(page);
    index.set(k, arr);
  };
  for (const p of pages) {
    add(p.title, p);
    add(p.slug, p);
    add(p.relPath, p);
    add(p.relPath.replace(/\.md$/i, ""), p);
  }
  return {
    resolve(rawTarget: string) {
      const key = bareTarget(rawTarget).toLowerCase();
      const candidates = index.get(key) ?? [];
      if (candidates.length === 1) return { page: candidates[0]!, ambiguous: false, candidates };
      if (candidates.length > 1) return { page: null, ambiguous: true, candidates };
      return { page: null, ambiguous: false, candidates: [] };
    },
  };
}

/**
 * Backlinks keyed by the *resolved* page relPath (not raw link text), so a page
 * linked by title in one place and by slug in another is counted once. Ambiguous
 * and unresolvable links are ignored (they are not real backlinks to any one page).
 */
export function buildBacklinksByPath(pages: PageInfo[], resolver: LinkResolver): Map<string, string[]> {
  const backlinks = new Map<string, string[]>();
  for (const p of pages) {
    for (const target of p.outlinks) {
      const { page } = resolver.resolve(target);
      if (!page) continue;
      const arr = backlinks.get(page.relPath) ?? [];
      if (!arr.includes(p.relPath)) arr.push(p.relPath);
      backlinks.set(page.relPath, arr);
    }
  }
  return backlinks;
}

/**
 * Rewrite wikilink targets via a per-link replacer, preserving #anchor and |alias
 * verbatim. `replacer` receives the bare target; return a new target to rewrite, or
 * null to leave the link untouched.
 */
export function rewriteWikilinks(
  body: string,
  replacer: (target: string) => string | null,
): { body: string; count: number } {
  let count = 0;
  const next = body.replace(WIKILINK_CAPTURE_RE, (whole, target: string, anchor?: string, alias?: string) => {
    const replacement = replacer(target.trim());
    if (replacement == null) return whole;
    count++;
    return `[[${replacement}${anchor ?? ""}${alias ?? ""}]]`;
  });
  return { body: next, count };
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
