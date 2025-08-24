import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

/**
 * Resolve the directory that holds the eval datasets.
 * Order:
 * 1) BFCL_DATA_DIR env var override
 * 2) Resolve the installed package root via require.resolve("@ai-sdk-tool/eval") and use its sibling 'data'
 * 3) Resolve the installed package root via require.resolve("@ai-sdk-tool/eval/package.json") and use its sibling 'data'
 * 4) Walk up from current module location to find nearest sibling 'data' directory
 * 5) Fallback to package-root/data assuming dist/benchmarks depth or cwd
 * 3) Walk up from current module location to find nearest sibling 'data' directory
 * 4) Fallback to package-root/data assuming dist/benchmarks depth or cwd
 */
export function resolveDataDir(fromModuleUrl?: string): string {
  // 0) Use provided module URL when available; otherwise rely on require/cwd fallbacks (avoids import.meta in CJS)
  const moduleUrl = fromModuleUrl;

  // 1) Explicit override
  const override = process.env.BFCL_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }

  // 2) Resolve via installed package location (works with pnpm workspaces and published package)
  try {
    // Prefer resolving the package main entry (exported by package.json) so we don't rely on exporting package.json
    const baseForRequireEntry =
      (typeof moduleUrl === "string" && moduleUrl) ||
      path.join(process.cwd(), "package.json");
    const requireFromEntry = createRequire(baseForRequireEntry);
    const entryPath = requireFromEntry.resolve("@ai-sdk-tool/eval");
    const entryDir = path.dirname(entryPath);
    // If entry is in dist/, walk up to package root and locate 'data'
    const guessPkgRoot = fs.existsSync(path.join(entryDir, ".."))
      ? path.resolve(entryDir, "..")
      : entryDir;
    const dataAtRoot = path.join(guessPkgRoot, "data");
    if (fs.existsSync(dataAtRoot)) return dataAtRoot;
  } catch {
    // ignore and continue to other strategies
  }

  try {
    // In CJS builds, import.meta.url may be empty. Fallback to cwd package.json path for a valid base.
    const baseForRequire =
      (typeof moduleUrl === "string" && moduleUrl) ||
      path.join(process.cwd(), "package.json");
    const require = createRequire(baseForRequire);
    // Resolve this package's package.json location
    const pkgJsonPath = require.resolve("@ai-sdk-tool/eval/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    const dataAtPkg = path.join(pkgDir, "data");
    if (fs.existsSync(dataAtPkg)) return dataAtPkg;
  } catch {
    // ignore if resolution fails (e.g., unusual environments)
  }

  // 3) Walk up a few levels to find a 'data' directory from the module URL
  let startDir: string;
  if (moduleUrl) {
    try {
      startDir = path.dirname(fileURLToPath(moduleUrl));
    } catch {
      // In case moduleUrl is invalid or unavailable, fall back to cwd
      startDir = process.cwd();
    }
  } else {
    startDir = process.cwd();
  }
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const dataCandidate = path.join(dir, "data");
    if (fs.existsSync(dataCandidate)) return dataCandidate;
    const parent = path.resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // 4) Fallback to packageRoot/data assuming dist/benchmarks -> dist -> packageRoot
  const pkgRoot = path.resolve(startDir, "..", "..");
  return path.join(pkgRoot, "data");
}
