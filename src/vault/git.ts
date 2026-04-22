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
