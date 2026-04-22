import { z } from "zod";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const ResponseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable");

/** A vault-relative path. No leading slash, no drive letter, no .. traversal. */
export const VaultPath = z
  .string()
  .min(1)
  .max(1024)
  .describe("Vault-relative POSIX path. Must not start with '/' or contain '..'.");
