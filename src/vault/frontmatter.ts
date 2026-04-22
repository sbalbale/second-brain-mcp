import matter from "gray-matter";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export function parseMarkdown(text: string): ParsedMarkdown {
  const parsed = matter(text);
  return {
    frontmatter: (parsed.data as Record<string, unknown>) ?? {},
    body: parsed.content ?? "",
    hasFrontmatter: Object.keys(parsed.data ?? {}).length > 0,
  };
}

/**
 * Merge `updates` into existing frontmatter and reserialize the file.
 * Preserves the body verbatim. Arrays are deduplicated and appended
 * (useful for `sources:` and `tags:` accumulation).
 */
export function mergeFrontmatter(
  existing: string,
  updates: Record<string, unknown>,
  opts: { arrayStrategy?: "append-unique" | "replace" } = {},
): string {
  const strategy = opts.arrayStrategy ?? "append-unique";
  const parsed = matter(existing);
  const base = (parsed.data as Record<string, unknown>) ?? {};
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(updates)) {
    const cur = merged[k];
    if (Array.isArray(cur) && Array.isArray(v) && strategy === "append-unique") {
      const seen = new Set<string>();
      const combined: unknown[] = [];
      for (const item of [...cur, ...v]) {
        const key = typeof item === "string" ? item : JSON.stringify(item);
        if (!seen.has(key)) {
          seen.add(key);
          combined.push(item);
        }
      }
      merged[k] = combined;
    } else {
      merged[k] = v;
    }
  }
  return matter.stringify(parsed.content ?? "", merged);
}

/** Build a fresh markdown file with frontmatter and body. */
export function buildMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body, frontmatter);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
