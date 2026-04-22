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
  CF_ACCESS_TEAM_DOMAIN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  CF_ACCESS_AUD: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  VAULT_AUTOCOMMIT: boolFromEnv.default("true"),
  DEFAULT_RESPONSE_FORMAT: z.enum(["markdown", "json"]).default("markdown"),
  READ_ONLY: boolFromEnv.default("false"),
  OPENAI_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
