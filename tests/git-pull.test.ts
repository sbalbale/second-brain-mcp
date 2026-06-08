import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitUpstream,
  gitFetch,
  gitAheadBehind,
  gitChangedBetween,
  gitDirtyFiles,
  gitFileHistory,
  gitHeadSha,
  gitPull,
  gitShowFile,
} from '../src/vault/git.js';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function configure(repo: string) {
  git(repo, 'config', 'user.email', 't@t.test');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

function commitFile(repo: string, name: string, content: string, message: string) {
  writeFileSync(path.join(repo, name), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', message);
}

describe('gitPull (temp local repos, no network)', () => {
  let base: string;
  let remote: string;
  let A: string; // pusher
  let B: string; // the repo under test

  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'sbm-git-'));
    remote = path.join(base, 'remote.git');
    A = path.join(base, 'A');
    B = path.join(base, 'B');

    git(base, 'init', '--bare', '-b', 'main', 'remote.git');

    mkdirSync(A);
    git(A, 'init', '-b', 'main');
    configure(A);
    commitFile(A, 'seed.md', '# seed\n', 'seed');
    git(A, 'remote', 'add', 'origin', remote);
    git(A, 'push', '-u', 'origin', 'main');

    git(base, 'clone', remote, 'B');
    configure(B);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('up to date: upstream set, behind 0, ff-only succeeds', async () => {
    expect(await gitUpstream(B)).toContain('origin/main');
    await gitFetch(B);
    expect(await gitAheadBehind(B)).toEqual({ ahead: 0, behind: 0 });
    const res = await gitPull(B, 'ff-only');
    expect(res.success).toBe(true);
  });

  test('behind only: fast-forwards cleanly', async () => {
    commitFile(A, 'new.md', '# new\n', 'add new');
    git(A, 'push', 'origin', 'main');

    await gitFetch(B);
    expect(await gitAheadBehind(B)).toEqual({ ahead: 0, behind: 1 });

    const res = await gitPull(B, 'ff-only');
    expect(res.success).toBe(true);
    // file now present in B
    expect(() => git(B, 'cat-file', '-e', 'HEAD:new.md')).not.toThrow();
  });

  test('diverged + ff-only: reports diverged, no throw, no spurious abort', async () => {
    // remote advances
    commitFile(A, 'remote.md', '# remote\n', 'remote change');
    git(A, 'push', 'origin', 'main');
    // local advances independently
    commitFile(B, 'local.md', '# local\n', 'local change');

    await gitFetch(B);
    const ab = await gitAheadBehind(B);
    expect(ab.ahead).toBe(1);
    expect(ab.behind).toBe(1);

    const res = await gitPull(B, 'ff-only');
    expect(res.success).toBe(false);
    expect(res.reason).toBe('diverged');
    // local commit is intact; working tree not left mid-merge
    expect(() => git(B, 'cat-file', '-e', 'HEAD:local.md')).not.toThrow();
  });

  test('no upstream: gitUpstream returns null', async () => {
    const C = path.join(base, 'C');
    mkdirSync(C);
    git(C, 'init', '-b', 'main');
    configure(C);
    commitFile(C, 'x.md', '# x\n', 'x');
    expect(await gitUpstream(C)).toBeNull();
  });

  test('gitDirtyFiles reports untracked, modified, staged, and rename destinations', async () => {
    writeFileSync(path.join(B, 'untracked.md'), '# untracked\n');
    writeFileSync(path.join(B, 'seed.md'), '# seed modified\n');
    writeFileSync(path.join(B, 'staged.md'), '# staged\n');
    git(B, 'add', 'staged.md');
    renameSync(path.join(B, 'staged.md'), path.join(B, 'renamed.md'));
    git(B, 'add', '-A');

    const files = await gitDirtyFiles(B);
    expect(files.sort()).toEqual(['renamed.md', 'seed.md', 'untracked.md']);
  });

  test('gitChangedBetween, gitFileHistory, gitHeadSha, and gitShowFile expose commit data', async () => {
    const before = await gitHeadSha(B);
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    commitFile(B, 'history.md', '# v1\n', 'history v1');
    const mid = await gitHeadSha(B);
    writeFileSync(path.join(B, 'history.md'), '# v2\n');
    git(B, 'add', '-A');
    git(B, 'commit', '-m', 'history v2');
    const after = await gitHeadSha(B);
    expect(after).toMatch(/^[0-9a-f]{40}$/);

    expect(await gitChangedBetween(B, before!, after!)).toEqual(['history.md']);

    const history = await gitFileHistory(B, 'history.md', 10);
    expect(history.map((c) => c.subject)).toEqual(['history v2', 'history v1']);

    await expect(gitShowFile(B, mid!, 'history.md')).resolves.toBe('# v1\n');
  });
});
