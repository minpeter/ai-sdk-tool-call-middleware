import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  FILESYSTEM_MCP_PACKAGE,
  McpStdioClient,
  type McpToolDefinition,
} from "./mcp-stdio-client";

export const MCPMARK_COMMIT = "cd45b7f57923b9b3985467f5139927575f83141c";

export const MCPMARK_TASK_INSTRUCTION_SUFFIX =
  "Note: Based on your understanding, solve the task all at once by yourself, don't ask for my opinions on anything.";

const SECRET_ENVIRONMENT_NAME =
  /(?:api[_-]?key|authorization|credential|password|secret|token)/i;

export const FILESYSTEM_CATEGORIES = [
  "file_context",
  "file_property",
  "folder_structure",
  "legal_document",
  "papers",
  "student_database",
] as const;

export type FilesystemCategory = (typeof FILESYSTEM_CATEGORIES)[number];

export const OFFICIAL_EASY_TASK_IDS = [
  "file_context/file_splitting",
  "file_context/pattern_matching",
  "file_context/uppercase",
  "file_property/largest_rename",
  "file_property/txt_merging",
  "folder_structure/structure_analysis",
  "legal_document/file_reorganize",
  "papers/papers_counting",
  "student_database/duplicate_name",
  "student_database/recommender_name",
] as const;

export type OfficialEasyTaskId = (typeof OFFICIAL_EASY_TASK_IDS)[number];

export interface FilesystemDataset {
  category: FilesystemCategory;
  etag: string;
  lastModified?: string;
  sha256: string;
  url: string;
}

export const FILESYSTEM_DATASETS: readonly FilesystemDataset[] = [
  {
    category: "file_context",
    etag: "0ce9f9d6191e58921636effc04c95e6f",
    lastModified: "Thu, 14 Aug 2025 04:42:23 GMT",
    sha256: "d133c03da0ea824a41dbae4ae9af38cf3c4086a0145174aad0ea5666249bbcd8",
    url: "https://storage.mcpmark.ai/filesystem/file_context.zip",
  },
  {
    category: "file_property",
    etag: "e98b6f1947d002b8216110a2eda78721",
    lastModified: "Thu, 14 Aug 2025 03:10:15 GMT",
    sha256: "99d5449cef45bfcda6e5260f6ef4cd356bdbae59818d37ffa840054cdee19ec4",
    url: "https://storage.mcpmark.ai/filesystem/file_property.zip",
  },
  {
    category: "folder_structure",
    etag: "8bfc9b05ccc9a029d97ff268d5220d59",
    sha256: "231f9d42040216bb64d4148154b89040f00ac830271dc8f338ac2df719424137",
    url: "https://storage.mcpmark.ai/filesystem/folder_structure.zip",
  },
  {
    category: "legal_document",
    etag: "675c4f11f70e794b338edabd391d1cec",
    sha256: "225e469124d2159a2ba5b77b2d39805ac2cce8099870a7482fb37a630dd74c09",
    url: "https://storage.mcpmark.ai/filesystem/legal_document.zip",
  },
  {
    category: "papers",
    etag: "74ce6c8f7067c340b48ec7ee361941b3",
    sha256: "927da33d642186fbf23eb551bb52171cc0b8902813c238de1a41fb258e7bf28d",
    url: "https://storage.mcpmark.ai/filesystem/papers.zip",
  },
  {
    category: "student_database",
    etag: "093f42e63b459baace58151850b021d2",
    sha256: "b070246c99332f817a65fd4ad50b6a60db3ad635718915afae7a12d463358633",
    url: "https://storage.mcpmark.ai/filesystem/student_database.zip",
  },
];

export interface OfficialFilesystemTask {
  category: FilesystemCategory;
  descriptionHash: string;
  directory: string;
  id: OfficialEasyTaskId;
  instruction: string;
  instructionHash: string;
  meta: Record<string, unknown>;
  metaHash: string;
  taskId: string;
  verifierHash: string;
  verifierPath: string;
}

function sanitizedChildEnvironment(
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...additions }).filter(
      ([name, value]) =>
        value !== undefined && !SECRET_ENVIRONMENT_NAME.test(name)
    )
  );
}

export interface PreparedDataset extends FilesystemDataset {
  dataPath: string;
  source: "cache" | "download" | "existing";
  treeHash: string;
  zipPath: string;
}

export interface VerifierResult {
  error?: string;
  exitCode: number | null;
  passed: boolean;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 8000);
  }
  return String(error).slice(0, 8000);
}

export function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function nonNegativeInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function toolSchemaFingerprint(tools: McpToolDefinition[]): string {
  const exposed = tools
    .map(({ description, inputSchema, name }) => ({
      description,
      inputSchema,
      name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return sha256Text(stableJson(exposed));
}

/** Hashes paths, file contents, symlink targets, and file modes deterministically. */
export function hashTree(root: string): string {
  const hash = createHash("sha256");
  const permissionMode = (mode: number): number => mode % 0o1_0000;
  const visit = (path: string): void => {
    const entryPath = relative(root, path).split("\\").join("/") || ".";
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      hash.update(`L\0${entryPath}\0${permissionMode(stats.mode)}\0`);
      hash.update(readlinkSync(path));
      hash.update("\0");
      return;
    }
    if (stats.isDirectory()) {
      hash.update(`D\0${entryPath}\0${permissionMode(stats.mode)}\0`);
      for (const name of readdirSync(path).sort((left, right) =>
        left.localeCompare(right)
      )) {
        visit(join(path, name));
      }
      return;
    }
    if (stats.isFile()) {
      hash.update(
        `F\0${entryPath}\0${permissionMode(stats.mode)}\0${stats.size}\0`
      );
      hash.update(readFileSync(path));
      hash.update("\0");
      return;
    }
    hash.update(`O\0${entryPath}\0${stats.mode}\0`);
  };
  visit(root);
  return hash.digest("hex");
}

function commandOutput(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: sanitizedChildEnvironment(),
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`
    );
  }
  return result.stdout.trim();
}

export function discoverOfficialEasyTasks(
  mcpmarkRoot: string
): OfficialFilesystemTask[] {
  const root = resolve(mcpmarkRoot);
  const commit = commandOutput("git", ["rev-parse", "HEAD"], root);
  if (commit !== MCPMARK_COMMIT) {
    throw new Error(
      `MCPMark commit mismatch: expected ${MCPMARK_COMMIT}, got ${commit}`
    );
  }
  const worktreeStatus = commandOutput(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    root
  );
  if (worktreeStatus) {
    throw new Error(
      "MCPMark checkout must be clean so task prompts and verifiers match the pinned commit"
    );
  }

  const easyRoot = join(root, "tasks", "filesystem", "easy");
  const actualIds: string[] = [];
  for (const category of readdirSync(easyRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) {
      continue;
    }
    const categoryPath = join(easyRoot, category.name);
    for (const task of readdirSync(categoryPath, { withFileTypes: true })) {
      if (
        task.isDirectory() &&
        existsSync(join(categoryPath, task.name, "meta.json"))
      ) {
        actualIds.push(`${category.name}/${task.name}`);
      }
    }
  }
  actualIds.sort((left, right) => left.localeCompare(right));
  const expectedIds = [...OFFICIAL_EASY_TASK_IDS].sort((left, right) =>
    left.localeCompare(right)
  );
  if (stableJson(actualIds) !== stableJson(expectedIds)) {
    throw new Error(
      `Official Easy task set drifted. Expected ${expectedIds.join(", ")}; got ${actualIds.join(", ")}`
    );
  }

  return OFFICIAL_EASY_TASK_IDS.map((id) => {
    const [category, taskId] = id.split("/") as [FilesystemCategory, string];
    const directory = join(easyRoot, category, taskId);
    const metaPath = join(directory, "meta.json");
    const descriptionPath = join(directory, "description.md");
    const verifierPath = join(directory, "verify.py");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (meta.task_id !== taskId || meta.category_id !== category) {
      throw new Error(`Task metadata identity mismatch for ${id}`);
    }
    if (!(existsSync(descriptionPath) && existsSync(verifierPath))) {
      throw new Error(`Task ${id} is missing description.md or verify.py`);
    }
    const instruction = `${readFileSync(descriptionPath, "utf8")}\n\n${MCPMARK_TASK_INSTRUCTION_SUFFIX}`;
    return {
      category,
      descriptionHash: sha256File(descriptionPath),
      directory,
      id,
      instruction,
      instructionHash: sha256Text(instruction),
      meta,
      metaHash: sha256File(metaPath),
      taskId,
      verifierHash: sha256File(verifierPath),
      verifierPath,
    };
  });
}

function downloadDataset(dataset: FilesystemDataset, target: string): void {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--silent",
      "--show-error",
      "--output",
      temporary,
      dataset.url,
    ],
    {
      encoding: "utf8",
      env: sanitizedChildEnvironment(),
      timeout: 300_000,
    }
  );
  if (result.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(
      `Failed to download ${dataset.url}: ${(result.stderr || result.error?.message || "unknown error").trim()}`
    );
  }
  const actualHash = sha256File(temporary);
  if (actualHash !== dataset.sha256) {
    rmSync(temporary, { force: true });
    throw new Error(
      `Downloaded ${dataset.category} SHA-256 mismatch: expected ${dataset.sha256}, got ${actualHash}`
    );
  }
  renameSync(temporary, target);
}

function obtainZip(
  dataset: FilesystemDataset,
  downloadRoot: string,
  cacheRoot: string
): { path: string; source: "cache" | "download" | "existing" } {
  mkdirSync(downloadRoot, { recursive: true });
  const target = join(downloadRoot, `${dataset.category}.zip`);
  if (existsSync(target)) {
    const actual = sha256File(target);
    if (actual === dataset.sha256) {
      return { path: target, source: "existing" };
    }
    rmSync(target, { force: true });
  }

  const candidates = [
    join(cacheRoot, `mcpmark-${dataset.category}.zip`),
    join(cacheRoot, `${dataset.category}.zip`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && sha256File(candidate) === dataset.sha256) {
      copyFileSync(candidate, target, constants.COPYFILE_FICLONE);
      if (sha256File(target) !== dataset.sha256) {
        rmSync(target, { force: true });
        throw new Error(`Copied cache became corrupt for ${dataset.category}`);
      }
      return { path: target, source: "cache" };
    }
  }

  downloadDataset(dataset, target);
  return { path: target, source: "download" };
}

function extractDataset(
  dataset: FilesystemDataset,
  zipPath: string,
  dataRoot: string
): string {
  const stage = mkdtempSync(join(dataRoot, `.extract-${dataset.category}-`));
  try {
    const result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", stage], {
      encoding: "utf8",
      env: sanitizedChildEnvironment(),
      timeout: 300_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `unzip failed for ${dataset.category}: ${(result.stderr || result.error?.message || "unknown error").trim()}`
      );
    }
    rmSync(join(stage, "__MACOSX"), { force: true, recursive: true });
    const extracted = join(stage, dataset.category);
    if (!(existsSync(extracted) && statSync(extracted).isDirectory())) {
      throw new Error(
        `${dataset.category}.zip did not contain ${dataset.category}/`
      );
    }
    const target = join(dataRoot, dataset.category);
    rmSync(target, { force: true, recursive: true });
    renameSync(extracted, target);
    return target;
  } finally {
    rmSync(stage, { force: true, recursive: true });
  }
}

export function prepareFilesystemData(
  dataRoot: string,
  categories: readonly FilesystemCategory[] = FILESYSTEM_CATEGORIES
): PreparedDataset[] {
  const root = resolve(dataRoot);
  mkdirSync(root, { recursive: true });
  const cacheRoot = resolve(process.env.MCPMARK_ZIP_CACHE_ROOT ?? "/tmp");
  const manifestPath = join(root, ".mcpmark-prepared.json");
  const priorManifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        datasets?: PreparedDataset[];
      })
    : undefined;
  const priorByCategory = new Map(
    (priorManifest?.datasets ?? []).map((dataset) => [
      dataset.category,
      dataset,
    ])
  );
  const records: PreparedDataset[] = [];

  for (const category of categories) {
    const dataset = FILESYSTEM_DATASETS.find(
      (candidate) => candidate.category === category
    );
    if (!dataset) {
      throw new Error(`No pinned dataset record for ${category}`);
    }
    const zip = obtainZip(dataset, join(root, ".downloads"), cacheRoot);
    const existingPath = join(root, category);
    const prior = priorByCategory.get(category);
    let dataPath: string;
    let treeHash: string;
    if (
      prior?.sha256 === dataset.sha256 &&
      existsSync(existingPath) &&
      statSync(existingPath).isDirectory()
    ) {
      const actualTreeHash = hashTree(existingPath);
      if (actualTreeHash === prior.treeHash) {
        dataPath = existingPath;
        treeHash = actualTreeHash;
      } else {
        dataPath = extractDataset(dataset, zip.path, root);
        treeHash = hashTree(dataPath);
      }
    } else {
      dataPath = extractDataset(dataset, zip.path, root);
      treeHash = hashTree(dataPath);
    }
    records.push({
      ...dataset,
      dataPath,
      source: zip.source,
      treeHash,
      zipPath: zip.path,
    });
  }

  const merged = new Map(
    (priorManifest?.datasets ?? []).map((dataset) => [
      dataset.category,
      dataset,
    ])
  );
  for (const record of records) {
    merged.set(record.category, record);
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        datasets: FILESYSTEM_CATEGORIES.flatMap((category) => {
          const record = merged.get(category);
          return record ? [record] : [];
        }),
        generatedAt: new Date().toISOString(),
        sourceCommit: MCPMARK_COMMIT,
      },
      null,
      2
    )}\n`
  );
  return records;
}

export function createPristineSnapshot(
  sourceCategoryPath: string,
  snapshotRoot: string,
  label: string
): string {
  mkdirSync(snapshotRoot, { recursive: true });
  const safeLabel = label.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 100);
  const snapshot = mkdtempSync(join(resolve(snapshotRoot), `${safeLabel}-`));
  rmSync(snapshot, { recursive: true });
  cpSync(sourceCategoryPath, snapshot, {
    errorOnExist: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
    preserveTimestamps: true,
    recursive: true,
  });
  return snapshot;
}

export function runOfficialVerifier(
  task: OfficialFilesystemTask,
  snapshot: string,
  timeoutMs = 120_000
): VerifierResult {
  const result = spawnSync(
    process.env.MCPMARK_PYTHON ?? "python3",
    [task.verifierPath],
    {
      cwd: task.directory,
      encoding: "utf8",
      env: sanitizedChildEnvironment({ FILESYSTEM_TEST_DIR: snapshot }),
      timeout: timeoutMs,
    }
  );
  const timedOut = Boolean(
    result.error && "code" in result.error && result.error.code === "ETIMEDOUT"
  );
  return {
    ...(result.error ? { error: normalizeError(result.error) } : {}),
    exitCode: result.status,
    passed: result.status === 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    timedOut,
  };
}

export async function preflightFilesystemServer(options: {
  dataRoot: string;
  requestTimeoutMs: number;
  snapshotRoot: string;
  task: OfficialFilesystemTask;
}): Promise<{
  schemaHash: string;
  serverPackage: string;
  serverStderr: string;
  tools: McpToolDefinition[];
}> {
  const snapshot = createPristineSnapshot(
    join(options.dataRoot, options.task.category),
    options.snapshotRoot,
    `schema-preflight-${options.task.category}`
  );
  let client: McpStdioClient | undefined;
  try {
    client = await McpStdioClient.connect({
      allowedRoot: snapshot,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    const tools = await client.listTools();
    if (tools.length === 0) {
      throw new Error("Filesystem MCP server exposed zero tools");
    }
    return {
      schemaHash: toolSchemaFingerprint(tools),
      serverPackage: FILESYSTEM_MCP_PACKAGE,
      serverStderr: client.stderr(),
      tools,
    };
  } finally {
    await client?.close();
    rmSync(snapshot, { force: true, recursive: true });
  }
}

export function resultPathFromOut(out: string, filename: string): string {
  return join(dirname(resolve(out)), filename);
}

export function shortPath(path: string): string {
  return `${basename(dirname(path))}/${basename(path)}`;
}
