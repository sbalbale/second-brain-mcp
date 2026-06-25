import type { Config } from "../config.js";
import { AppCache } from "./cache.js";
import { AsyncLimiter } from "./concurrency.js";
import { onVaultMutation } from "./vault-events.js";

export interface AppRuntime {
  cache: AppCache;
  runRead<T>(task: () => Promise<T>): Promise<T>;
  runWrite<T>(task: () => Promise<T>): Promise<T>;
  runGit<T>(task: () => Promise<T>): Promise<T>;
  runRag<T>(task: () => Promise<T>): Promise<T>;
}

let runtime: AppRuntime | null = null;
let listenerInstalled = false;

export function getRuntime(cfg: Config): AppRuntime {
  if (runtime) return runtime;

  const cache = new AppCache(cfg);
  const readLimiter = new AsyncLimiter(cfg.MAX_READ_CONCURRENCY);
  const writeLimiter = new AsyncLimiter(cfg.MAX_WRITE_CONCURRENCY);
  const gitLimiter = new AsyncLimiter(cfg.GIT_CONCURRENCY);
  const ragLimiter = new AsyncLimiter(cfg.RAG_QUERY_CONCURRENCY);

  runtime = {
    cache,
    runRead: (task) => readLimiter.run(task),
    runWrite: (task) => writeLimiter.run(task),
    runGit: (task) => gitLimiter.run(task),
    runRag: (task) => ragLimiter.run(task),
  };

  if (!listenerInstalled) {
    onVaultMutation((vaultRoot) => cache.invalidateVault(vaultRoot));
    listenerInstalled = true;
  }

  return runtime;
}
