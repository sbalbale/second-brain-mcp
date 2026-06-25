import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Config } from "../src/config.js";

const redisMock = vi.hoisted(() => {
  const state = {
    store: new Map<string, string>(),
    failConnect: false,
    failGet: false,
    failSetEx: false,
    clients: [] as Array<{
      isReady: boolean;
      connect: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      setEx: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    }>,
    client: undefined as undefined | {
      isReady: boolean;
      connect: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      setEx: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    },
  };

  const createClient = vi.fn(() => {
    const client = {
      isReady: false,
      connect: vi.fn(async () => {
        if (state.failConnect) throw new Error("redis down");
        client.isReady = true;
      }),
      get: vi.fn(async (key: string) => {
        if (state.failGet) throw new Error("get failed");
        return state.store.get(key) ?? null;
      }),
      set: vi.fn(async (key: string, value: string) => {
        state.store.set(key, value);
      }),
      setEx: vi.fn(async (key: string, _seconds: number, value: string) => {
        if (state.failSetEx) throw new Error("set failed");
        state.store.set(key, value);
      }),
      on: vi.fn(),
      destroy: vi.fn(() => {
        client.isReady = false;
      }),
    };
    state.client = client;
    state.clients.push(client);
    return client;
  });

  return { state, createClient };
});

vi.mock("redis", () => ({
  createClient: redisMock.createClient,
}));

const { AppCache } = await import("../src/runtime/cache.js");

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
    REDIS_URL: "redis://redis:6379",
    CACHE_NAMESPACE: "redis-test",
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

beforeEach(() => {
  redisMock.state.store.clear();
  redisMock.state.failConnect = false;
  redisMock.state.failGet = false;
  redisMock.state.failSetEx = false;
  redisMock.state.clients = [];
  redisMock.state.client = undefined;
  redisMock.createClient.mockClear();
});

describe("AppCache Redis integration", () => {
  test("stores values in Redis and reuses them across cache instances", async () => {
    const first = new AppCache(cfg());
    const second = new AppCache(cfg());
    let calls = 0;

    await expect(first.getOrSet("C:/vault", "scope", "key", async () => ++calls)).resolves.toBe(1);
    await expect(second.getOrSet("C:/vault", "scope", "key", async () => ++calls)).resolves.toBe(1);

    expect(calls).toBe(1);
    expect(redisMock.state.clients.some((client) => client.setEx.mock.calls.length > 0)).toBe(true);
  });

  test("writes a Redis vault version on invalidation", async () => {
    const cache = new AppCache(cfg());

    await cache.invalidateVault("C:/vault");

    expect(redisMock.state.client?.set).toHaveBeenCalledWith(
      expect.stringContaining(":vault:"),
      expect.any(String),
    );
  });

  test("falls back to memory when Redis connect fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    redisMock.state.failConnect = true;
    const cache = new AppCache(cfg());
    let calls = 0;

    await expect(cache.getOrSet("C:/vault", "scope", "key", async () => ++calls)).resolves.toBe(1);
    await expect(cache.getOrSet("C:/vault", "scope", "key", async () => ++calls)).resolves.toBe(1);

    expect(calls).toBe(1);
    expect(redisMock.state.client?.destroy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Redis cache unavailable"));
    errorSpy.mockRestore();
  });

  test("falls back to loader when Redis reads or writes fail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    redisMock.state.failGet = true;
    redisMock.state.failSetEx = true;
    const cache = new AppCache(cfg());

    await expect(cache.getOrSet("C:/vault", "scope", "key", async () => "loaded")).resolves.toBe("loaded");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Redis cache version read failed"));
    errorSpy.mockRestore();
  });
});
