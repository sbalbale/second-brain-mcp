import { afterEach, describe, expect, test, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { assertAuthConfigured, buildAuthMiddleware } from "../src/auth.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function config(overrides: Partial<Config> = {}): Config {
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
    CACHE_TTL_SECONDS: 30,
    CACHE_MAX_ENTRIES: 100,
    MAX_READ_CONCURRENCY: 4,
    MAX_WRITE_CONCURRENCY: 1,
    GIT_CONCURRENCY: 1,
    RAG_QUERY_CONCURRENCY: 1,
    QMD_UPDATE_DEBOUNCE_MS: 500,
    ...overrides,
  };
}

function mockReq(headers: Record<string, string | undefined>): Request {
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res as Response & typeof res;
}

describe("loadConfig", () => {
  test("parses defaults, booleans, numbers, and optional empty strings", () => {
    process.env = {
      VAULT_ROOT: "vault",
      AUTH_TOKEN: "",
      VAULT_AUTOCOMMIT: "no",
      READ_ONLY: "yes",
      CACHE_ENABLED: "1",
      CACHE_TTL_SECONDS: "45",
      MAX_READ_CONCURRENCY: "12",
    };

    const cfg = loadConfig();
    expect(cfg.VAULT_ROOT).toMatch(/vault$/);
    expect(cfg.AUTH_TOKEN).toBeUndefined();
    expect(cfg.VAULT_AUTOCOMMIT).toBe(false);
    expect(cfg.READ_ONLY).toBe(true);
    expect(cfg.CACHE_ENABLED).toBe(true);
    expect(cfg.CACHE_TTL_SECONDS).toBe(45);
    expect(cfg.MAX_READ_CONCURRENCY).toBe(12);
    expect(cfg.REDIS_URL).toBeUndefined();
  });

  test("rejects partial OAuth configuration and invalid ports", () => {
    process.env = {
      VAULT_ROOT: "vault",
      PORT: "70000",
      OAUTH_ISSUER: "https://issuer.example/",
    };

    expect(() => loadConfig()).toThrow(/Invalid configuration/);
  });
});

describe("auth middleware", () => {
  test("accepts a matching static bearer token and attaches auth info", async () => {
    const req = mockReq({ authorization: "Bearer secret" }) as Request & { auth?: unknown };
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await buildAuthMiddleware(config())(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.auth).toEqual({ token: "secret" });
  });

  test("rejects missing or wrong bearer tokens", async () => {
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await buildAuthMiddleware(config())(mockReq({ authorization: "Bearer wrong" }) as Request, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or missing Bearer/OAuth token" });
  });

  test("allows loopback without auth but rejects unauthenticated public bind", async () => {
    const next = vi.fn() as NextFunction;
    const res = mockRes();

    await buildAuthMiddleware(config({ AUTH_TOKEN: undefined }))(mockReq({}) as Request, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(() => assertAuthConfigured(config({ HOST: "0.0.0.0", AUTH_TOKEN: undefined }))).toThrow(/Refusing to start/);
    expect(() => assertAuthConfigured(config({ HOST: "localhost", AUTH_TOKEN: undefined }))).not.toThrow();
  });
});

describe("createServer", () => {
  test("constructs an MCP server with registered tools and prompts", () => {
    expect(createServer(config())).toBeTruthy();
  });
});
