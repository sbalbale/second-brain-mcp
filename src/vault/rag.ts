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
export async function generateEmbedding(text: string, apiKey: string, modelName: string = "gemini-embedding-2"): Promise<number[]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

/**
 * Wrapper for generateEmbedding with exponential backoff for 429 (Rate Limit) errors.
 */
export async function generateEmbeddingWithRetry(
  text: string,
  apiKey: string,
  modelName: string = "gemini-embedding-2",
  maxRetries: number = 5
): Promise<number[]> {
  let retries = 0;
  while (true) {
    try {
      return await generateEmbedding(text, apiKey, modelName);
    } catch (err: any) {
      const errorText = String(err?.message || "");
      const isRateLimit = errorText.includes("429") || err?.status === 429 || errorText.toLowerCase().includes("too many requests");
      
      if (isRateLimit && retries < maxRetries) {
        const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
        console.error(`[RAG] Rate limited (429). Retrying in ${Math.round(delay)}ms... (Attempt ${retries + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        retries++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Generates embeddings for multiple texts in a single batch call.
 * This is more efficient and helps stay within rate limits for free tier.
 */
export async function batchEmbedContents(texts: string[], apiKey: string, modelName: string = "gemini-embedding-2"): Promise<number[][]> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName });
  
  // Gemini supports up to 100 texts per batch
  const result = await model.batchEmbedContents({
    requests: texts.map(text => ({
      content: { role: "user", parts: [{ text }] },
    })),
  });
  
  return result.embeddings.map(e => e.values);
}

/**
 * Wrapper for batchEmbedContents with exponential backoff for 429 (Rate Limit) errors.
 */
export async function batchEmbedContentsWithRetry(
  texts: string[],
  apiKey: string,
  modelName: string = "gemini-embedding-2",
  maxRetries: number = 5
): Promise<number[][]> {
  let retries = 0;
  while (true) {
    try {
      return await batchEmbedContents(texts, apiKey, modelName);
    } catch (err: any) {
      // Check for 429 error in message or status
      const errorText = String(err?.message || "");
      const isRateLimit = errorText.includes("429") || err?.status === 429 || errorText.toLowerCase().includes("too many requests");
      
      if (isRateLimit && retries < maxRetries) {
        // Exponential backoff: 2^retries * 1000ms + jitter
        const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
        console.error(`[RAG] Rate limited (429). Retrying in ${Math.round(delay)}ms... (Attempt ${retries + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        retries++;
        continue;
      }
      throw err;
    }
  }
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
