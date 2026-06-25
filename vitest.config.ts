import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/auth.ts",
        "src/config.ts",
        "src/runtime/**/*.ts",
        "src/schemas/**/*.ts",
        "src/server.ts",
        "src/vault/frontmatter.ts",
        "src/vault/fs.ts",
        "src/vault/links.ts",
        "src/vault/maintenance.ts",
        "src/vault/paths.ts",
      ],
      exclude: [
        "src/index.ts",
        "src/prompts/**",
        "src/tools/**",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
});
