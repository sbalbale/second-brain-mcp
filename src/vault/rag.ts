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

export function qmdQuery(query: string, limit: number = 5, minScore: number = 0.2): QmdResult[] {
  const raw = execFileSync(
    "qmd",
    ["query", query, "--json", "-n", String(limit), "--min-score", String(minScore)],
    { encoding: "utf8" }
  );
  return JSON.parse(raw) as QmdResult[];
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

export async function startQmdIndexing(vaultRoot: string): Promise<QmdIndexStatus> {
  const jobId = randomUUID();
  const startedAt = nowIso();
  const status: QmdIndexStatus = {
    jobId,
    state: "running",
    phase: "update",
    startedAt,
    updatedAt: startedAt,
  };

  await writeStatus(vaultRoot, status);
  void runQmdIndexJob(vaultRoot, jobId);
  return status;
}

export function startQmdUpdate(vaultRoot: string): void {
  void runQmd(vaultRoot, ["update"]).catch((err) => {
    console.error(`qmd update failed: ${describeError(err)}`);
  });
}

export async function readQmdIndexStatus(vaultRoot: string): Promise<QmdIndexStatus | null> {
  if (!(await exists(vaultRoot, RAG_INDEX_STATUS_FILE))) {
    return null;
  }

  return JSON.parse(await readText(vaultRoot, RAG_INDEX_STATUS_FILE)) as QmdIndexStatus;
}
