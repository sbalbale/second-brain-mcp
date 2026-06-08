import { spawn } from "node:child_process";

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  untracked: number;
  modified: number;
  staged: number;
  ahead: number;
  behind: number;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  return code === 0;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    return {
      isRepo: false, branch: null, dirty: false,
      untracked: 0, modified: 0, staged: 0, ahead: 0, behind: 0,
    };
  }
  const branchRes = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;

  const statusRes = await run("git", ["status", "--porcelain=v1", "--branch"], cwd);
  let untracked = 0, modified = 0, staged = 0, ahead = 0, behind = 0;
  for (const line of statusRes.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("##")) {
      const ma = line.match(/ahead (\d+)/);
      const mb = line.match(/behind (\d+)/);
      if (ma?.[1]) ahead = parseInt(ma[1], 10);
      if (mb?.[1]) behind = parseInt(mb[1], 10);
      continue;
    }
    const code = line.slice(0, 2);
    if (code === "??") untracked++;
    else {
      if (code[0] && code[0] !== " ") staged++;
      if (code[1] && code[1] !== " ") modified++;
    }
  }
  const dirty = untracked + modified + staged > 0;
  return { isRepo: true, branch, dirty, untracked, modified, staged, ahead, behind };
}

export async function gitCommitAll(cwd: string, message: string): Promise<{ committed: boolean; sha: string | null; stderr: string }> {
  if (!(await isGitRepo(cwd))) return { committed: false, sha: null, stderr: "not a git repo" };
  await run("git", ["add", "-A"], cwd);
  const statusRes = await run("git", ["diff", "--cached", "--quiet"], cwd);
  // diff --cached --quiet exits 0 if no staged changes, 1 if there are changes.
  if (statusRes.code === 0) {
    return { committed: false, sha: null, stderr: "nothing to commit" };
  }
  const commitRes = await run("git", ["commit", "-m", message], cwd);
  if (commitRes.code !== 0) {
    return { committed: false, sha: null, stderr: commitRes.stderr };
  }
  const shaRes = await run("git", ["rev-parse", "HEAD"], cwd);
  return { committed: true, sha: shaRes.stdout.trim(), stderr: "" };
}

export interface GitCommit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
}

/** Return commits within the last `sinceSeconds` seconds (or all if 0). */
export async function gitLog(cwd: string, sinceSeconds: number, limit = 50): Promise<GitCommit[]> {
  if (!(await isGitRepo(cwd))) return [];
  const args = [
    "log",
    "--name-only",
    `--pretty=format:__commit__%n%H%n%ad%n%an%n%s`,
    "--date=iso-strict",
    "-n",
    String(limit),
  ];
  if (sinceSeconds > 0) {
    args.splice(1, 0, `--since=${sinceSeconds} seconds ago`);
  }
  const res = await run("git", args, cwd);
  const commits: GitCommit[] = [];
  const blocks = res.stdout.split(/^__commit__$/m).map((s) => s.trim()).filter(Boolean);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    const [sha, date, author, subject, ...files] = lines;
    if (!sha) continue;
    commits.push({
      sha, date: date ?? "", author: author ?? "", subject: subject ?? "",
      files: files.filter((f) => f && f.trim().length > 0),
    });
  }
  return commits;
}

export async function gitPush(cwd: string): Promise<{ success: boolean; stdout: string; stderr: string }> {
  if (!(await isGitRepo(cwd))) return { success: false, stdout: "", stderr: "not a git repo" };
  const res = await run("git", ["push"], cwd);
  return { success: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/** Name of the upstream tracking branch (e.g. "origin/main"), or null if none is set. */
export async function gitUpstream(cwd: string): Promise<string | null> {
  const res = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function gitFetch(cwd: string, remote = "origin"): Promise<{ success: boolean; stderr: string }> {
  const res = await run("git", ["fetch", remote], cwd);
  return { success: res.code === 0, stderr: res.stderr };
}

/** Vault-relative paths of dirty (untracked / modified / staged) files. */
export async function gitDirtyFiles(cwd: string): Promise<string[]> {
  if (!(await isGitRepo(cwd))) return [];
  const res = await run("git", ["status", "--porcelain=v1"], cwd);
  const out: string[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    let p = line.slice(3); // strip 2-char XY status + space
    if (p.includes(" -> ")) p = p.split(" -> ").pop()!; // renames: take destination
    out.push(p.trim());
  }
  return out;
}

/**
 * Commits ahead of / behind the upstream. Caller must confirm an upstream exists
 * (gitUpstream) first. `rev-list --left-right --count HEAD...@{u}` prints
 * "<ahead>\t<behind>": left side = commits only on HEAD (ahead), right side =
 * commits only on upstream (behind).
 */
export async function gitAheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
  const res = await run("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], cwd);
  if (res.code !== 0) return { ahead: 0, behind: 0 };
  const [a, b] = res.stdout.trim().split(/\s+/);
  return { ahead: parseInt(a ?? "0", 10) || 0, behind: parseInt(b ?? "0", 10) || 0 };
}

export async function gitHeadSha(cwd: string): Promise<string | null> {
  const res = await run("git", ["rev-parse", "HEAD"], cwd);
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function gitChangedBetween(cwd: string, a: string, b: string): Promise<string[]> {
  const res = await run("git", ["diff", "--name-only", `${a}..${b}`], cwd);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export interface PullResult {
  success: boolean;                       // pull completed and HEAD advanced
  reason?: "not-a-repo" | "diverged" | "conflict";
  conflicts?: string[];
  stderr: string;
}

/**
 * Pull from upstream. Failure handling is split by strategy:
 *  - ff-only: a failed fast-forward creates no merge/rebase state and no unmerged
 *    paths — there is nothing to abort. Report reason:"diverged".
 *  - rebase: capture unmerged paths *before* aborting (diff --diff-filter=U is empty
 *    after --abort), then abort only if mid-rebase (conflicts present). Never auto-resolves.
 */
export async function gitPull(cwd: string, strategy: "ff-only" | "rebase"): Promise<PullResult> {
  if (!(await isGitRepo(cwd))) return { success: false, reason: "not-a-repo", stderr: "not a git repo" };
  const args = strategy === "rebase" ? ["pull", "--rebase"] : ["pull", "--ff-only"];
  const res = await run("git", args, cwd);
  if (res.code === 0) return { success: true, stderr: res.stderr };

  if (strategy === "rebase") {
    const conflicts = await unmergedPaths(cwd);
    if (conflicts.length > 0) {
      await run("git", ["rebase", "--abort"], cwd); // gated: only when mid-rebase with conflicts
    }
    return { success: false, reason: "conflict", conflicts, stderr: res.stderr };
  }
  // ff-only failure: local and remote both advanced; fast-forward impossible.
  return { success: false, reason: "diverged", stderr: res.stderr };
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  const res = await run("git", ["diff", "--name-only", "--diff-filter=U"], cwd);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Per-file commit history (`git log --follow`). */
export async function gitFileHistory(
  cwd: string,
  relPath: string,
  limit = 50,
): Promise<{ sha: string; date: string; subject: string }[]> {
  if (!(await isGitRepo(cwd))) return [];
  const res = await run(
    "git",
    ["log", "--follow", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s", "-n", String(limit), "--", relPath],
    cwd,
  );
  if (res.code !== 0) return [];
  const out: { sha: string; date: string; subject: string }[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [sha, date, ...rest] = line.split("\t");
    if (!sha) continue;
    out.push({ sha, date: date ?? "", subject: rest.join("\t") });
  }
  return out;
}

/** Contents of a file at a given commit (`git show <sha>:<path>`). */
export async function gitShowFile(cwd: string, sha: string, relPath: string): Promise<string> {
  const res = await run("git", ["show", `${sha}:${relPath}`], cwd);
  if (res.code !== 0) throw new Error(res.stderr || `git show failed for ${sha}:${relPath}`);
  return res.stdout;
}

/** Commit all changes when autocommit is enabled; no-op otherwise. */
export async function maybeAutocommit(
  autocommit: boolean,
  root: string,
  message: string,
): Promise<{ committed: boolean; sha: string | null }> {
  if (!autocommit) return { committed: false, sha: null };
  const res = await gitCommitAll(root, message);
  return { committed: res.committed, sha: res.sha };
}

interface RunResult { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.on("error", () => resolve({ code: 1, stdout, stderr: "spawn error" }));
  });
}
