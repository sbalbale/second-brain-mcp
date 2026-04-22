import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface Chunk {
  path: string;
  text: string;
  embedding: number[];
}

export interface Index {
  chunks: Chunk[];
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generates an embedding using Google's text-embedding-004 model.
 * Free tier is available for Gemini.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

export async function loadIndex(vaultRoot: string): Promise<Index> {
  const p = path.join(vaultRoot, ".rag-index.json");
  try {
    const data = await fs.readFile(p, "utf8");
    return JSON.parse(data) as Index;
  } catch {
    return { chunks: [] };
  }
}

export async function saveIndex(vaultRoot: string, index: Index): Promise<void> {
  const p = path.join(vaultRoot, ".rag-index.json");
  await fs.writeFile(p, JSON.stringify(index), "utf8");
}

export async function searchIndex(index: Index, queryEmbedding: number[], limit = 5) {
  const scored = index.chunks.map(c => ({
    path: c.path,
    text: c.text,
    score: cosineSimilarity(queryEmbedding, c.embedding)
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
