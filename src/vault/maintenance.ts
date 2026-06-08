import type { PageInfo, LinkResolver } from "./links.js";
import { slugify } from "./paths.js";

/**
 * Structured lint findings. `wiki_lint_scan` formats these for humans and
 * `wiki_lint_fix` consumes them directly. Broken vs ambiguous links are kept
 * distinct so fix logic only ever touches the unambiguous subset.
 */
export type LintIssue =
  | { type: "orphan"; page: string }
  | { type: "broken-link"; page: string; target: string }
  | { type: "ambiguous-link"; page: string; target: string; candidates: string[] }
  | { type: "missing-frontmatter"; page: string; missing: string[] };

/** Map a wiki subdirectory category to a singular frontmatter `type` value. */
export function categoryToType(category: PageInfo["category"]): string {
  switch (category) {
    case "sources": return "source";
    case "entities": return "entity";
    case "concepts": return "concept";
    case "synthesis": return "synthesis";
    default: return "note";
  }
}

/**
 * Pure lint detector shared by scan and fix. `backlinksByPath` must be keyed by
 * resolved page relPath (see buildBacklinksByPath). External (http) links are
 * always considered resolvable.
 */
export function scanLint(
  pages: PageInfo[],
  resolver: LinkResolver,
  backlinksByPath: Map<string, string[]>,
  requiredFields: string[],
): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const p of pages) {
    // Orphans: no resolved inbound links.
    const bls = backlinksByPath.get(p.relPath) ?? [];
    if (bls.length === 0) {
      issues.push({ type: "orphan", page: p.relPath });
    }

    // Frontmatter completeness.
    const missing = requiredFields.filter((f) => !(f in p.frontmatter));
    if (missing.length > 0) {
      issues.push({ type: "missing-frontmatter", page: p.relPath, missing });
    }

    // Outgoing link health.
    for (const target of p.outlinks) {
      if (/^https?:\/\//i.test(target)) continue;
      const { page, ambiguous, candidates } = resolver.resolve(target);
      if (ambiguous) {
        issues.push({ type: "ambiguous-link", page: p.relPath, target, candidates: candidates.map((c) => c.relPath) });
      } else if (!page) {
        issues.push({ type: "broken-link", page: p.relPath, target });
      }
    }
  }
  return issues;
}

/**
 * Attempt to canonicalize a broken link target. Conservative: only returns a
 * replacement when slugifying the target lands on exactly one page (an unambiguous
 * format/punctuation variant of a real note). Returns null for genuinely missing or
 * ambiguous targets, which are left for human review.
 */
export function resolveBrokenLink(target: string, resolver: LinkResolver): string | null {
  // If it already resolves, it isn't broken — nothing to fix.
  if (resolver.resolve(target).page) return null;
  const viaSlug = resolver.resolve(slugify(target));
  if (viaSlug.page) return viaSlug.page.slug;
  return null;
}

/**
 * Extract inline #tags from a markdown body. Skips fenced and inline code, ignores
 * '# Heading' lines (a tag has no space after #), and drops purely-numeric tags.
 * Preserves case; dedups within the body.
 */
export function extractInlineTags(body: string): string[] {
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of stripped.matchAll(/(?:^|[\s(])#([A-Za-z0-9_/\-]+)/g)) {
    const tag = m[1]!;
    if (/^\d+$/.test(tag)) continue; // pure numbers aren't tags in Obsidian
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Extract unique {{variable}} names from template content. */
export function extractTemplateVars(content: string): string[] {
  const seen = new Set<string>();
  for (const m of content.matchAll(/\{\{\s*([\w.\-]+)\s*\}\}/g)) {
    seen.add(m[1]!);
  }
  return [...seen];
}

/**
 * Render the body of wiki/index.md: pages grouped by type (sorted), each as a
 * path-form wikilink. Extracted from wiki_index_rebuild so lint-fix and rebuild
 * share one routine. Sorts pages by path for stable output.
 */
export function formatIndexBody(pages: { path: string; title: string; type: string }[]): string {
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  let body = "# Wiki Index\n\n";
  const types = [...new Set(sorted.map((p) => p.type))].sort();
  for (const t of types) {
    body += `## ${t.charAt(0).toUpperCase() + t.slice(1)}\n`;
    for (const p of sorted.filter((p) => p.type === t)) {
      body += `- [[${p.path}|${p.title}]]\n`;
    }
    body += "\n";
  }
  return body;
}
