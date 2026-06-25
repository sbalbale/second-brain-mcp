import { z } from "zod";
import path from "node:path";

const boolFromEnv = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const ConfigSchema = z.object({
  VAULT_ROOT: z.string().min(1, "VAULT_ROOT must be set").transform((p) => path.resolve(p)),
  TRANSPORT: z.enum(["http", "stdio"]).default("http"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  AUTH_TOKEN: optionalString,
  OAUTH_ISSUER: optionalString,
  OAUTH_AUDIENCE: optionalString,
  OAUTH_AUTH_ENDPOINT: optionalString,
  OAUTH_TOKEN_ENDPOINT: optionalString,
  CF_ACCESS_TEAM_DOMAIN: optionalString,
  CF_ACCESS_AUD: optionalString,
  VAULT_AUTOCOMMIT: boolFromEnv.default("true"),
  DEFAULT_RESPONSE_FORMAT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["markdown", "json"]).default("markdown"),
  ),
  READ_ONLY: boolFromEnv.default("false"),
  CACHE_ENABLED: boolFromEnv.default("true"),
  REDIS_URL: optionalString,
  CACHE_NAMESPACE: z.string().min(1).default("second-brain-mcp"),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(30),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(10).default(1000),
  MAX_READ_CONCURRENCY: z.coerce.number().int().min(1).default(16),
  MAX_WRITE_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  GIT_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  RAG_QUERY_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  QMD_UPDATE_DEBOUNCE_MS: z.coerce.number().int().min(0).default(2000),
}).refine(
  (data) => {
    const hasAnyOAuth = !!(data.OAUTH_ISSUER || data.OAUTH_AUDIENCE || data.OAUTH_AUTH_ENDPOINT || data.OAUTH_TOKEN_ENDPOINT);
    if (hasAnyOAuth) {
      return !!(data.OAUTH_ISSUER && data.OAUTH_AUDIENCE && data.OAUTH_AUTH_ENDPOINT && data.OAUTH_TOKEN_ENDPOINT);
    }
    return true;
  },
  {
    message: "OAUTH_ISSUER, OAUTH_AUDIENCE, OAUTH_AUTH_ENDPOINT, and OAUTH_TOKEN_ENDPOINT must all be set if using OAuth",
    path: ["OAUTH_ISSUER"],
  },
);

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
