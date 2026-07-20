import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

const SECRET_ENVIRONMENT_NAME =
  /(?:api[_-]?key|authorization|credential|password|secret|token)/i;

export function assertGitRevision(options: {
  expected: string;
  label: string;
  root: string;
}): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) =>
        value !== undefined && !SECRET_ENVIRONMENT_NAME.test(name)
    )
  );
  const actual = execFileSync(
    "git",
    ["-C", options.root, "rev-parse", "HEAD"],
    {
      encoding: "utf8",
      env,
    }
  ).trim();
  if (actual !== options.expected) {
    throw new Error(
      `${options.label} commit mismatch: expected ${options.expected}, got ${actual}`
    );
  }
}

export function configurationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function collectFiles(path: string, files: string[]): void {
  const stats = statSync(path);
  if (stats.isFile()) {
    files.push(path);
    return;
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Implementation fingerprint path is not a file or directory: ${path}`
    );
  }
  for (const entry of readdirSync(path).sort()) {
    collectFiles(resolve(path, entry), files);
  }
}

export function sourceTreeFingerprint(options: {
  paths: readonly string[];
  root: string;
}): string {
  const root = resolve(options.root);
  const files: string[] = [];
  for (const input of options.paths) {
    collectFiles(resolve(input), files);
  }
  const uniqueFiles = [...new Set(files)].sort((left, right) => {
    const leftRelative = relative(root, left);
    const rightRelative = relative(root, right);
    return leftRelative.localeCompare(rightRelative);
  });
  if (uniqueFiles.length === 0) {
    throw new Error("Implementation fingerprint requires at least one file");
  }
  const hash = createHash("sha256");
  for (const file of uniqueFiles) {
    const name = relative(root, file).split(sep).join("/");
    if (name === ".." || name.startsWith("../")) {
      throw new Error(
        `Implementation fingerprint path is outside root: ${file}`
      );
    }
    const bytes = readFileSync(file);
    hash.update(`${Buffer.byteLength(name)}\0${name}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

export function benchmarkImplementationFingerprint(): string {
  const benchmarkRoot = resolve(
    REPOSITORY_ROOT,
    "benchmarks/glm-5.2-tool-calling"
  );
  const productionSourceRoot = resolve(REPOSITORY_ROOT, "src");
  const productionPaths = readdirSync(productionSourceRoot)
    .filter((entry) => entry !== "__tests__")
    .map((entry) => resolve(productionSourceRoot, entry));
  const benchmarkSourceRoot = resolve(benchmarkRoot, "src");
  const benchmarkPaths = readdirSync(benchmarkSourceRoot)
    .filter((entry) => !entry.endsWith(".test.ts"))
    .map((entry) => resolve(benchmarkSourceRoot, entry));
  const analysisPaths = readdirSync(benchmarkRoot)
    .filter((entry) => entry.endsWith(".py"))
    .map((entry) => resolve(benchmarkRoot, entry));
  return sourceTreeFingerprint({
    paths: [
      ...productionPaths,
      ...benchmarkPaths,
      ...analysisPaths,
      resolve(REPOSITORY_ROOT, "package.json"),
      resolve(REPOSITORY_ROOT, "pnpm-lock.yaml"),
      resolve(REPOSITORY_ROOT, "tsconfig.json"),
      resolve(benchmarkRoot, "tsconfig.json"),
    ],
    root: REPOSITORY_ROOT,
  });
}

export function assertResumeFingerprint(options: {
  expected: string;
  metaPath: string;
  outputPath: string;
  resume: boolean;
}): void {
  if (!options.resume) {
    return;
  }
  const metaExists = existsSync(options.metaPath);
  const outputExists = existsSync(options.outputPath);
  if (metaExists !== outputExists) {
    throw new Error(
      `Cannot resume ${options.outputPath}: raw output and run metadata must either both exist or both be absent`
    );
  }
  if (!metaExists) {
    return;
  }
  const previous = JSON.parse(readFileSync(options.metaPath, "utf8")) as {
    configFingerprint?: string;
  };
  if (previous.configFingerprint !== options.expected) {
    throw new Error(
      `Cannot resume ${options.outputPath}: configuration fingerprint mismatch ` +
        `(expected ${options.expected}, found ${previous.configFingerprint ?? "missing"})`
    );
  }
}
