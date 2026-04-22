import path from "node:path";
import fs from "node:fs/promises";

export class PathSafetyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PathSafetyError";
  }
}

/**
 * Resolve a vault-relative path to an absolute path, rejecting any attempt
 * to escape the vault root (via .., absolute paths, or symlink traversal).
 *
 * `relPath` is treated as a POSIX-style vault-relative path. Leading slashes,
 * backslashes, and drive letters are rejected.
 */
export function safeJoin(vaultRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new PathSafetyError("Path must be a non-empty string.");
  }
  // Reject absolute paths and drive letters outright.
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new PathSafetyError(`Absolute paths are not allowed: ${relPath}`);
  }
  // Normalize and re-check traversal.
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized === "..") {
    throw new PathSafetyError(`Path escapes vault root: ${relPath}`);
  }
  const abs = path.resolve(vaultRoot, normalized);
  const rootResolved = path.resolve(vaultRoot);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new PathSafetyError(`Path escapes vault root: ${relPath}`);
  }
  return abs;
}

/**
 * Verify the real on-disk path (after resolving symlinks) is still inside
 * the vault. Call this on any path that might have been a symlink.
 */
export async function assertRealPathInside(vaultRoot: string, absPath: string): Promise<void> {
  try {
    const real = await fs.realpath(absPath);
    const rootReal = await fs.realpath(vaultRoot);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new PathSafetyError(`Symlink escapes vault root: ${absPath}`);
    }
  } catch (err: unknown) {
    // If the path doesn't exist yet (writes), fall back to lexical check only.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Convert an absolute path inside the vault back to a vault-relative posix path. */
export function toVaultRel(vaultRoot: string, absPath: string): string {
  const rel = path.relative(path.resolve(vaultRoot), absPath);
  return rel.split(path.sep).join("/");
}

/** Slugify a title into a kebab-case filename stem. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/['"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
