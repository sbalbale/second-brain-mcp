import { createHash } from "node:crypto";
import { createClient } from "redis";
import type { Config } from "../config.js";
import { SingleFlight } from "./concurrency.js";

type RedisLike = {
  isReady?: boolean;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  setEx(key: string, seconds: number, value: string): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
};

type MemoryEntry = {
  expiresAt: number;
  value: unknown;
};

class MemoryCache {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(private readonly maxEntries: number) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;

    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      value,
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

function hash(value: unknown): string {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(json).digest("hex").slice(0, 24);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppCache {
  private readonly memory: MemoryCache;
  private readonly singleFlight = new SingleFlight();
  private readonly vaultVersions = new Map<string, string>();
  private redis: RedisLike | null = null;
  private connectPromise: Promise<RedisLike | null> | null = null;
  private redisDisabledUntil = 0;
  private warnedRedisError = false;

  constructor(private readonly cfg: Config) {
    this.memory = new MemoryCache(cfg.CACHE_MAX_ENTRIES);
  }

  async getOrSet<T>(
    vaultRoot: string,
    scope: string,
    keyParts: unknown,
    loader: () => Promise<T>,
    ttlSeconds = this.cfg.CACHE_TTL_SECONDS,
  ): Promise<T> {
    if (!this.cfg.CACHE_ENABLED || ttlSeconds <= 0) {
      return this.singleFlight.run(`${scope}:${hash(keyParts)}`, loader);
    }

    const vaultHash = hash(vaultRoot);
    const version = await this.vaultVersion(vaultHash);
    const key = `${this.cfg.CACHE_NAMESPACE}:cache:${vaultHash}:${version}:${scope}:${hash(keyParts)}`;

    return this.singleFlight.run(key, async () => {
      const memoryHit = this.memory.get<T>(key);
      if (memoryHit !== undefined) return memoryHit;

      const redisHit = await this.redisGet<T>(key);
      if (redisHit !== undefined) {
        this.memory.set(key, redisHit, ttlSeconds);
        return redisHit;
      }

      const value = await loader();
      this.memory.set(key, value, ttlSeconds);
      await this.redisSet(key, value, ttlSeconds);
      return value;
    });
  }

  async invalidateVault(vaultRoot: string): Promise<void> {
    const vaultHash = hash(vaultRoot);
    const nextVersion = Date.now().toString(36);
    this.vaultVersions.set(vaultHash, nextVersion);

    const redis = await this.getRedis();
    if (!redis) return;

    try {
      await redis.set(this.versionKey(vaultHash), nextVersion);
    } catch (err) {
      this.warnRedis(`Redis cache invalidation failed: ${describeError(err)}`);
    }
  }

  private async vaultVersion(vaultHash: string): Promise<string> {
    const redis = await this.getRedis();
    if (redis) {
      try {
        const redisVersion = await redis.get(this.versionKey(vaultHash));
        if (redisVersion) {
          this.vaultVersions.set(vaultHash, redisVersion);
          return redisVersion;
        }
      } catch (err) {
        this.warnRedis(`Redis cache version read failed: ${describeError(err)}`);
      }
    }

    const memoryVersion = this.vaultVersions.get(vaultHash);
    if (memoryVersion) return memoryVersion;

    this.vaultVersions.set(vaultHash, "0");
    return "0";
  }

  private versionKey(vaultHash: string): string {
    return `${this.cfg.CACHE_NAMESPACE}:vault:${vaultHash}:version`;
  }

  private async redisGet<T>(key: string): Promise<T | undefined> {
    const redis = await this.getRedis();
    if (!redis) return undefined;

    try {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch (err) {
      this.warnRedis(`Redis cache read failed: ${describeError(err)}`);
      return undefined;
    }
  }

  private async redisSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const redis = await this.getRedis();
    if (!redis) return;

    try {
      await redis.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch (err) {
      this.warnRedis(`Redis cache write failed: ${describeError(err)}`);
    }
  }

  private async getRedis(): Promise<RedisLike | null> {
    if (!this.cfg.REDIS_URL || !this.cfg.CACHE_ENABLED) return null;
    if (this.redis?.isReady) return this.redis;
    if (Date.now() < this.redisDisabledUntil) return null;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connectRedis();
    return this.connectPromise;
  }

  private async connectRedis(): Promise<RedisLike | null> {
    const client = createClient({ url: this.cfg.REDIS_URL }) as unknown as RedisLike;
    client.on("error", (err) => {
      this.warnRedis(`Redis cache connection error: ${err.message}`);
    });

    try {
      await client.connect();
      this.redis = client;
      console.error(`[Cache] Redis connected at ${this.redisLogTarget()}`);
      return client;
    } catch (err) {
      this.warnRedis(`Redis cache unavailable, using process memory only: ${describeError(err)}`);
      this.redisDisabledUntil = Date.now() + 30_000;
      await client.disconnect().catch(() => {});
      return null;
    } finally {
      this.connectPromise = null;
    }
  }

  private warnRedis(message: string): void {
    if (this.warnedRedisError) return;
    this.warnedRedisError = true;
    console.error(`[Cache] ${message}`);
  }

  private redisLogTarget(): string {
    if (!this.cfg.REDIS_URL) return "redis";

    try {
      const parsed = new URL(this.cfg.REDIS_URL);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return "configured Redis URL";
    }
  }
}
