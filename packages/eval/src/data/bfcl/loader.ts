import fs from "fs";
import path from "path";
import type { BfclDataset } from "./types";

const DEFAULT_CACHE_DIR = path.join(process.cwd(), "data", "bfcl");

export function ensureCacheDir(cacheDir = DEFAULT_CACHE_DIR) {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * Load a local BFCL dataset file.
 * Supports either a single JSON document (BfclDataset) or JSONL (newline-delimited objects).
 * On error, throws so callers can handle fallbacks.
 */
export function loadLocalDataset(filePath: string): BfclDataset {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`BFCL dataset not found at path: ${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf-8");

  // Try full JSON document first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as unknown as BfclDataset;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as unknown as Record<string, unknown>).examples)
    ) {
      return (parsed as unknown as Record<string, unknown>)
        .examples as unknown as BfclDataset;
    }
    // otherwise fall through to try JSONL
  } catch {
    // Not a single JSON doc — try JSONL
  }

  // JSONL fallback: parse each line as a JSON object and return as an array
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`BFCL dataset at ${abs} is empty`);
  }
  const examples = lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(
        `Failed to parse JSONL line ${idx + 1} in ${abs}: ${(e as Error).message}`
      );
    }
  });

  return examples as unknown as BfclDataset;
}

export function cacheDataset(
  dataset: BfclDataset,
  cacheDir = DEFAULT_CACHE_DIR,
  fileName = "bfcl.json"
) {
  ensureCacheDir(cacheDir);
  const outPath = path.join(cacheDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(dataset, null, 2), "utf-8");
  return outPath;
}

export function loadCachedDataset(
  cacheDir = DEFAULT_CACHE_DIR,
  fileName = "bfcl.json"
) {
  const p = path.join(cacheDir, fileName);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8");
  try {
    return JSON.parse(raw) as BfclDataset;
  } catch {
    return null;
  }
}
