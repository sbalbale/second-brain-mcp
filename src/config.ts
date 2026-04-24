import { z } from "zod";
import path from "node:path";

const boolFromEnv = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0", "yes", "no"]))
  .transform((v) => v === "true" || v === "1" || v === "yes");

const ConfigSchema = z.object({
  VAULT_ROOT: z.string().min(1, "VAULT_ROOT must be set").transform((p) => path.resolve(p)),
  TRANSPORT: z.enum(["http", "stdio"]).default("http"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  AUTH_TOKEN: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  OAUTH_ISSUER: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  OAUTH_AUDIENCE: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  OAUTH_AUTH_ENDPOINT: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  OAUTH_TOKEN_ENDPOINT: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  CF_ACCESS_TEAM_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  CF_ACCESS_AUD: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  VAULT_AUTOCOMMIT: boolFromEnv.default("true"),
  DEFAULT_RESPONSE_FORMAT: z.enum(["markdown", "json"]).default("markdown"),
  READ_ONLY: boolFromEnv.default("false"),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-embedding-2"),
  GEMINI_FREE_TIER: boolFromEnv.default("true"),
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
