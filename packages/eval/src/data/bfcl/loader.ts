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

export function loadLocalDataset(filePath: string) {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`BFCL dataset not found at path: ${abs}`);
  }
  const raw = fs.readFileSync(abs, "utf-8");
  try {
    const parsed = JSON.parse(raw) as BfclDataset;
    return parsed;
  } catch (e) {
    throw new Error(
      `Failed to parse BFCL dataset JSON: ${(e as Error).message}`
    );
  }
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
