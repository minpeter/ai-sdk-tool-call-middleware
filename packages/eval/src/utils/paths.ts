import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Resolve the directory that holds the eval datasets.
 * Order:
 * 1) BFCL_DATA_DIR env var override
 * 2) Walk up from current module location to find nearest sibling 'data' directory
 * 3) Fallback to package-root/data assuming dist/benchmarks depth
 */
export function resolveDataDir(fromModuleUrl: string): string {
  // 1) Explicit override
  const override = process.env.BFCL_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }

  // 2) Walk up a few levels to find a 'data' directory
  const startDir = path.dirname(fileURLToPath(fromModuleUrl));
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const dataCandidate = path.join(dir, "data");
    if (fs.existsSync(dataCandidate)) return dataCandidate;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // 3) Fallback to packageRoot/data assuming dist/benchmarks -> dist -> packageRoot
  const pkgRoot = path.resolve(startDir, "..", "..");
  return path.join(pkgRoot, "data");
}
