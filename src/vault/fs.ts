import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { safeJoin, assertRealPathInside, toVaultRel, PathSafetyError } from "./paths.js";
import { TRASH_DIR } from "../constants.js";

export interface FileEntry {
  path: string; // vault-relative, posix
  type: "file" | "directory";
  size?: number;
  modified?: string; // ISO
}

/** Read a UTF-8 text file from the vault. */
export async function readText(vaultRoot: string, relPath: string): Promise<string> {
  const abs = safeJoin(vaultRoot, relPath);
  await assertRealPathInside(vaultRoot, abs);
  return fs.readFile(abs, "utf8");
}

/** Check whether a vault-relative path exists. */
export async function exists(vaultRoot: string, relPath: string): Promise<boolean> {
  try {
    const abs = safeJoin(vaultRoot, relPath);
    await fs.stat(abs);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Atomic UTF-8 write: write to a sibling temp file, fsync, then rename over
 * the destination. Safe for Obsidian Sync (no partial file observed).
 * Creates parent directories if requested.
 */
export async function writeTextAtomic(
  vaultRoot: string,
  relPath: string,
  contents: string,
  opts: { createParents?: boolean } = {},
): Promise<{ absPath: string; relPath: string; bytes: number }> {
  const abs = safeJoin(vaultRoot, relPath);
  const dir = path.dirname(abs);
  if (opts.createParents) {
    await fs.mkdir(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  const buf = Buffer.from(contents, "utf8");
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(buf);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, abs);
  return { absPath: abs, relPath: toVaultRel(vaultRoot, abs), bytes: buf.byteLength };
}

/** Move / rename inside the vault. Both paths must stay inside VAULT_ROOT. */
export async function moveInside(
  vaultRoot: string,
  fromRel: string,
  toRel: string,
  opts: { createParents?: boolean; overwrite?: boolean } = {},
): Promise<{ from: string; to: string }> {
  const fromAbs = safeJoin(vaultRoot, fromRel);
  const toAbs = safeJoin(vaultRoot, toRel);
  if (opts.createParents) {
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
  }
  if (!opts.overwrite) {
    try {
      await fs.stat(toAbs);
      throw new Error(`Destination already exists: ${toRel}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  await fs.rename(fromAbs, toAbs);
  return { from: toVaultRel(vaultRoot, fromAbs), to: toVaultRel(vaultRoot, toAbs) };
}

/**
 * Soft-delete: move the path into `.trash/<original-path>.<timestamp>`.
 * Reversible with a plain `mv` on the host.
 */
export async function softDelete(
  vaultRoot: string,
  relPath: string,
): Promise<{ originalPath: string; trashPath: string }> {
  const abs = safeJoin(vaultRoot, relPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const trashRel = `${TRASH_DIR}/${relPath}.${ts}`;
  const trashAbs = safeJoin(vaultRoot, trashRel);
  await fs.mkdir(path.dirname(trashAbs), { recursive: true });
  await fs.rename(abs, trashAbs);
  return { originalPath: toVaultRel(vaultRoot, abs), trashPath: toVaultRel(vaultRoot, trashAbs) };
}

/**
 * List a directory. Non-recursive by default; set depth > 0 to recurse.
 * `globFilter` is a simple glob on the POSIX relative path (supports * and ?).
 */
export async function listDir(
  vaultRoot: string,
  relDir: string,
  opts: { depth?: number; globFilter?: string; includeDirs?: boolean } = {},
): Promise<FileEntry[]> {
  const depth = opts.depth ?? 0;
  const includeDirs = opts.includeDirs ?? true;
  const filterRe = opts.globFilter ? globToRegExp(opts.globFilter) : null;

  const rootAbs = safeJoin(vaultRoot, relDir === "" || relDir === "." ? "." : relDir);
  const out: FileEntry[] = [];

  async function walk(currentAbs: string, currentDepth: number): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(currentAbs, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const abs = path.join(currentAbs, e.name);
      const rel = toVaultRel(vaultRoot, abs);
      // Skip .trash and .git unless explicitly requested via globFilter.
      if (!filterRe && (rel.startsWith(".trash/") || rel === ".trash" || rel.startsWith(".git/") || rel === ".git")) {
        continue;
      }
      const isDir = e.isDirectory();
      if (isDir && includeDirs && (!filterRe || filterRe.test(rel))) {
        out.push({ path: rel, type: "directory" });
      } else if (!isDir && (!filterRe || filterRe.test(rel))) {
        try {
          const st = await fs.stat(abs);
          out.push({
            path: rel,
            type: "file",
            size: st.size,
            modified: st.mtime.toISOString(),
          });
        } catch {
          // stat race — skip silently
        }
      }
      if (isDir && currentDepth < depth) {
        await walk(abs, currentDepth + 1);
      }
    }
  }

  await walk(rootAbs, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Convert a simple glob (supports *, **, ?) into a RegExp anchored to full string. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c && /[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export { PathSafetyError };
