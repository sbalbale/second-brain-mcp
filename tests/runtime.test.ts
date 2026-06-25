import { describe, expect, test, vi } from "vitest";
import { AppCache } from "../src/runtime/cache.js";
import { AsyncLimiter, SingleFlight } from "../src/runtime/concurrency.js";
import { notifyVaultMutation, onVaultMutation } from "../src/runtime/vault-events.js";
import type { Config } from "../src/config.js";

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    VAULT_ROOT: "C:/vault",
    TRANSPORT: "http",
    HOST: "127.0.0.1",
    PORT: 8787,
    AUTH_TOKEN: "secret",
    OAUTH_ISSUER: undefined,
    OAUTH_AUDIENCE: undefined,
    OAUTH_AUTH_ENDPOINT: undefined,
    OAUTH_TOKEN_ENDPOINT: undefined,
    CF_ACCESS_TEAM_DOMAIN: undefined,
    CF_ACCESS_AUD: undefined,
    VAULT_AUTOCOMMIT: true,
    DEFAULT_RESPONSE_FORMAT: "markdown",
    READ_ONLY: false,
    CACHE_ENABLED: true,
    REDIS_URL: undefined,
    CACHE_NAMESPACE: "test-cache",
    CACHE_TTL_SECONDS: 60,
    CACHE_MAX_ENTRIES: 10,
    MAX_READ_CONCURRENCY: 2,
    MAX_WRITE_CONCURRENCY: 1,
    GIT_CONCURRENCY: 1,
    RAG_QUERY_CONCURRENCY: 1,
    QMD_UPDATE_DEBOUNCE_MS: 2000,
    ...overrides,
  };
}

describe("AsyncLimiter", () => {
  test("bounds concurrent work and drains queued tasks", async () => {
    const limiter = new AsyncLimiter(2);
    let active = 0;
    let peak = 0;
    let started = 0;
    const releases: Array<() => void> = [];

    const tasks = Array.from({ length: 4 }, (_, i) =>
      limiter.run(async () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return i;
      }),
    );

    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toBe(3));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toBe(4));
    releases.splice(0).forEach((release) => release());

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  test("propagates task failures and continues the queue", async () => {
    const limiter = new AsyncLimiter(1);
    const first = limiter.run(async () => {
      throw new Error("boom");
    });
    const second = limiter.run(async () => "ok");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });
});

describe("SingleFlight", () => {
  test("shares identical in-flight work and clears after completion", async () => {
    const singleFlight = new SingleFlight();
    let calls = 0;
    const releases: Array<() => void> = [];
    const loader = () => {
      calls++;
      return new Promise<number>((resolve) => releases.push(() => resolve(42)));
    };

    const first = singleFlight.run("same", loader);
    const second = singleFlight.run("same", loader);

    expect(calls).toBe(1);
    releases.shift()?.();
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);

    await expect(singleFlight.run("same", async () => 7)).resolves.toBe(7);
    expect(calls).toBe(1);
  });
});

describe("AppCache", () => {
  test("caches values in memory and invalidates by vault version", async () => {
    const cache = new AppCache(cfg());
    let calls = 0;
    const load = () => Promise.resolve({ value: ++calls });

    await expect(cache.getOrSet("C:/vault", "scope", { q: "a" }, load)).resolves.toEqual({ value: 1 });
    await expect(cache.getOrSet("C:/vault", "scope", { q: "a" }, load)).resolves.toEqual({ value: 1 });
    expect(calls).toBe(1);

    await cache.invalidateVault("C:/vault");
    await expect(cache.getOrSet("C:/vault", "scope", { q: "a" }, load)).resolves.toEqual({ value: 2 });
  });

  test("single-flights when caching is disabled or ttl is zero", async () => {
    const cache = new AppCache(cfg({ CACHE_ENABLED: false }));
    let calls = 0;
    const releases: Array<() => void> = [];
    const loader = () => {
      calls++;
      return new Promise<string>((resolve) => releases.push(() => resolve("done")));
    };

    const first = cache.getOrSet("C:/vault", "scope", { q: "a" }, loader);
    const second = cache.getOrSet("C:/vault", "scope", { q: "a" }, loader);
    expect(calls).toBe(1);
    releases.shift()?.();
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);

    await expect(cache.getOrSet("C:/vault", "scope", { q: "a" }, async () => "fresh")).resolves.toBe("fresh");
    expect(calls).toBe(1);
  });

  test("does not store entries when ttl is zero", async () => {
    const cache = new AppCache(cfg());
    let calls = 0;
    const loader = () => Promise.resolve(++calls);

    await expect(cache.getOrSet("C:/vault", "scope", "key", loader, 0)).resolves.toBe(1);
    await expect(cache.getOrSet("C:/vault", "scope", "key", loader, 0)).resolves.toBe(2);
  });
});

describe("vault mutation events", () => {
  test("notifies listeners and keeps going if one fails", async () => {
    const seen: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    onVaultMutation((root, rel) => {
      seen.push(`${root}:${rel}`);
    });
    onVaultMutation(() => {
      throw new Error("listener failed");
    });

    await notifyVaultMutation("C:/vault", "wiki/a.md");
    expect(seen).toContain("C:/vault:wiki/a.md");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Mutation listener failed"));

    errorSpy.mockRestore();
  });
});
