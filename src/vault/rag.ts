import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { RAG_INDEX_STATUS_FILE } from "../constants.js";
import { exists, readText, writeTextAtomic } from "./fs.js";

export interface QmdResult {
  displayPath: string;
  score: number;
  snippet: string;
  title: string;
}

export interface QmdIndexStatus {
  jobId: string;
  state: "running" | "succeeded" | "failed";
  phase: "update" | "embed" | "done";
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  message?: string;
}

export function qmdUpdate(): void {
  execFileSync("qmd", ["update"], { stdio: "inherit" });
}

export function qmdEmbed(): void {
  execFileSync("qmd", ["embed"], { stdio: "inherit" });
}

export function qmdQuery(query: string, limit: number = 5, minScore: number = 0.2): Promise<QmdResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("qmd", ["query", query, "--json", "-n", String(limit), "--min-score", String(minScore)]);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const suffix = signal ? ` (signal ${signal})` : "";
        reject(new Error(`qmd query exited with code ${code ?? 1}${suffix}: ${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as QmdResult[]);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeStatus(vaultRoot: string, status: QmdIndexStatus): Promise<void> {
  await writeTextAtomic(vaultRoot, RAG_INDEX_STATUS_FILE, JSON.stringify(status, null, 2), { createParents: true });
}

function runQmd(vaultRoot: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("qmd", args, { cwd: vaultRoot, stdio: "inherit" });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const suffix = signal ? ` (signal ${signal})` : "";
      reject(new Error(`qmd ${args.join(" ")} exited with code ${code ?? 1}${suffix}`));
    });
  });
}

async function runQmdIndexJob(vaultRoot: string, jobId: string): Promise<void> {
  const startedAt = nowIso();
  let status: QmdIndexStatus = {
    jobId,
    state: "running",
    phase: "update",
    startedAt,
    updatedAt: startedAt,
  };

  try {
    await writeStatus(vaultRoot, status);

    await runQmd(vaultRoot, ["update"]);
    status = { ...status, phase: "embed", updatedAt: nowIso() };
    await writeStatus(vaultRoot, status);

    await runQmd(vaultRoot, ["embed"]);
    status = {
      ...status,
      state: "succeeded",
      phase: "done",
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      message: "qmd update and embed completed",
    };
    await writeStatus(vaultRoot, status);
  } catch (err) {
    status = {
      ...status,
      state: "failed",
      phase: "done",
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      message: describeError(err),
    };

    try {
      await writeStatus(vaultRoot, status);
    } catch (writeErr) {
      console.error(`Failed to write qmd index failure status: ${describeError(writeErr)}`);
    }

    console.error(`qmd indexing job ${jobId} failed: ${status.message}`);
  }
}

const activeIndexJobs = new Map<string, QmdIndexStatus>();
const pendingUpdates = new Map<string, NodeJS.Timeout>();
const runningUpdates = new Set<string>();

export async function startQmdIndexing(vaultRoot: string): Promise<QmdIndexStatus> {
  const active = activeIndexJobs.get(vaultRoot);
  if (active) return active;

  const jobId = randomUUID();
  const startedAt = nowIso();
  const status: QmdIndexStatus = {
    jobId,
    state: "running",
    phase: "update",
    startedAt,
    updatedAt: startedAt,
  };

  activeIndexJobs.set(vaultRoot, status);
  try {
    await writeStatus(vaultRoot, status);
  } catch (err) {
    activeIndexJobs.delete(vaultRoot);
    throw err;
  }
  void runQmdIndexJob(vaultRoot, jobId).finally(() => activeIndexJobs.delete(vaultRoot));
  return status;
}

export function startQmdUpdate(vaultRoot: string, debounceMs = 0): void {
  const existing = pendingUpdates.get(vaultRoot);
  if (existing) clearTimeout(existing);

  const run = () => {
    pendingUpdates.delete(vaultRoot);

    if (runningUpdates.has(vaultRoot)) {
      pendingUpdates.set(vaultRoot, setTimeout(run, Math.max(debounceMs, 1000)));
      return;
    }

    runningUpdates.add(vaultRoot);
    void runQmd(vaultRoot, ["update"])
      .catch((err) => {
        console.error(`qmd update failed: ${describeError(err)}`);
      })
      .finally(() => {
        runningUpdates.delete(vaultRoot);
      });
  };

  if (debounceMs > 0) {
    pendingUpdates.set(vaultRoot, setTimeout(run, debounceMs));
  } else {
    run();
  }
}

export async function readQmdIndexStatus(vaultRoot: string): Promise<QmdIndexStatus | null> {
  if (!(await exists(vaultRoot, RAG_INDEX_STATUS_FILE))) {
    return null;
  }

  return JSON.parse(await readText(vaultRoot, RAG_INDEX_STATUS_FILE)) as QmdIndexStatus;
}
