import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Try to resolve data directory via package entry point
 */
function tryResolveViaPackageEntry(moduleUrl?: string): string | null {
  try {
    const baseForRequireEntry =
      (typeof moduleUrl === "string" && moduleUrl) ||
      path.join(process.cwd(), "package.json");
    const requireFromEntry = createRequire(baseForRequireEntry);
    const entryPath = requireFromEntry.resolve("@ai-sdk-tool/eval");
    const entryDir = path.dirname(entryPath);
    const guessPkgRoot = fs.existsSync(path.join(entryDir, ".."))
      ? path.resolve(entryDir, "..")
      : entryDir;
    const dataAtRoot = path.join(guessPkgRoot, "data");
    if (fs.existsSync(dataAtRoot)) {
      return dataAtRoot;
    }
  } catch {
    // ignore and continue to other strategies
  }
  return null;
}

/**
 * Try to resolve data directory via package.json
 */
function tryResolveViaPackageJson(moduleUrl?: string): string | null {
  try {
    const baseForRequire =
      (typeof moduleUrl === "string" && moduleUrl) ||
      path.join(process.cwd(), "package.json");
    const require = createRequire(baseForRequire);
    const pkgJsonPath = require.resolve("@ai-sdk-tool/eval/package.json");
    const pkgDir = path.dirname(pkgJsonPath);
    const dataAtPkg = path.join(pkgDir, "data");
    if (fs.existsSync(dataAtPkg)) {
      return dataAtPkg;
    }
  } catch {
    // ignore if resolution fails
  }
  return null;
}

/**
 * Determine starting directory from module URL
 */
function getStartDir(moduleUrl?: string): string {
  if (moduleUrl) {
    try {
      return path.dirname(fileURLToPath(moduleUrl));
    } catch {
      return process.cwd();
    }
  }
  return process.cwd();
}

/**
 * Walk up directory tree to find data directory
 */
function findDataDirByTraversal(startDir: string): string | null {
  let dir = startDir;
  const MAX_PARENT_TRAVERSAL_DEPTH = 6;
  for (let i = 0; i < MAX_PARENT_TRAVERSAL_DEPTH; i++) {
    const dataCandidate = path.join(dir, "data");
    if (fs.existsSync(dataCandidate)) {
      return dataCandidate;
    }
    const parent = path.resolve(dir, "..");
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }
  return null;
}

/**
 * Resolve the directory that holds the eval datasets.
 * Order:
 * 1) BFCL_DATA_DIR env var override
 * 2) Resolve the installed package root via require.resolve("@ai-sdk-tool/eval") and use its sibling 'data'
 * 3) Resolve the installed package root via require.resolve("@ai-sdk-tool/eval/package.json") and use its sibling 'data'
 * 4) Walk up from current module location to find nearest sibling 'data' directory
 * 5) Fallback to package-root/data assuming dist/benchmarks depth or cwd
 */
export function resolveDataDir(fromModuleUrl?: string): string {
  // 1) Explicit override
  const override = process.env.BFCL_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }

  // 2) Try resolving via package entry point
  const viaEntry = tryResolveViaPackageEntry(fromModuleUrl);
  if (viaEntry) {
    return viaEntry;
  }

  // 3) Try resolving via package.json
  const viaPackageJson = tryResolveViaPackageJson(fromModuleUrl);
  if (viaPackageJson) {
    return viaPackageJson;
  }

  // 4) Walk up directory tree to find data directory
  const startDir = getStartDir(fromModuleUrl);
  const viaTraversal = findDataDirByTraversal(startDir);
  if (viaTraversal) {
    return viaTraversal;
  }

  // 5) Fallback to packageRoot/data assuming dist/benchmarks -> dist -> packageRoot
  const pkgRoot = path.resolve(startDir, "..", "..");
  return path.join(pkgRoot, "data");
}
