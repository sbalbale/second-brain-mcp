import { execFileSync } from "node:child_process";

export interface QmdResult {
  displayPath: string;
  score: number;
  snippet: string;
  title: string;
}

export function qmdUpdate(): void {
  execFileSync("qmd", ["update"], { stdio: "inherit" });
}

export function qmdEmbed(): void {
  execFileSync("qmd", ["embed"], { stdio: "inherit" });
}

export function qmdQuery(query: string, limit: number = 5, minScore: number = 0.2): QmdResult[] {
  const raw = execFileSync(
    "qmd",
    ["query", query, "--json", "-n", String(limit), "--min-score", String(minScore)],
    { encoding: "utf8" }
  );
  return JSON.parse(raw) as QmdResult[];
}
