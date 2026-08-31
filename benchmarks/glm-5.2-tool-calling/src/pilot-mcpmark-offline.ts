import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  FILESYSTEM_MCP_PACKAGE,
  type McpCallResult,
  McpStdioClient,
} from "./mcp-stdio-client";
import {
  createPristineSnapshot,
  discoverOfficialEasyTasks,
  hashTree,
  MCPMARK_COMMIT,
  type OfficialFilesystemTask,
  positiveInt,
  prepareFilesystemData,
  runOfficialVerifier,
  toolSchemaFingerprint,
} from "./mcpmark-filesystem-common";

const MCPMARK_ROOT = resolve(
  process.env.MCPMARK_ROOT ?? "/tmp/mcpmark-research"
);
const DATA_ROOT = resolve(
  process.env.MCPMARK_DATA_ROOT ?? "/tmp/mcpmark-filesystem-data"
);
const SNAPSHOT_ROOT = resolve(
  process.env.MCPMARK_SNAPSHOT_ROOT ?? "/tmp/mcpmark-filesystem-pilot"
);
const OUT = resolve(
  process.env.MCPMARK_PILOT_OUT ??
    "benchmarks/glm-5.2-tool-calling/results/mcpmark-offline-pilot.json"
);
const MCP_TIMEOUT_MS = positiveInt("MCPMARK_MCP_TIMEOUT_MS", 60_000);
const VERIFIER_TIMEOUT_MS = positiveInt("MCPMARK_VERIFIER_TIMEOUT_MS", 120_000);
const KEEP = process.env.MCPMARK_KEEP_PILOT_SNAPSHOTS === "1";
const JPG_LISTING_LINE = /\[FILE\].*\.jpg\b/i;
const SG_JPG = /\bsg\.jpg\b/;

interface PilotRecord {
  mcpCalls: {
    arguments: Record<string, unknown>;
    name: string;
    result: McpCallResult;
  }[];
  resultTreeHash: string;
  schemaHash: string;
  snapshot?: string;
  taskId: string;
  verification: ReturnType<typeof runOfficialVerifier>;
}

function textContent(result: McpCallResult): string {
  const block = result.content?.find(
    (candidate) =>
      candidate.type === "text" && typeof candidate.text === "string"
  );
  if (!block || typeof block.text !== "string") {
    throw new Error(
      `MCP result had no text content: ${JSON.stringify(result)}`
    );
  }
  return block.text;
}

async function checkedCall(
  client: McpStdioClient,
  calls: PilotRecord["mcpCalls"],
  name: string,
  argumentsValue: Record<string, unknown>
): Promise<McpCallResult> {
  const result = await client.callTool(name, argumentsValue);
  calls.push({ arguments: argumentsValue, name, result });
  if (result.isError) {
    throw new Error(`${name} returned isError=true: ${JSON.stringify(result)}`);
  }
  return result;
}

async function runLargestRename(
  task: OfficialFilesystemTask
): Promise<PilotRecord> {
  const snapshot = createPristineSnapshot(
    join(DATA_ROOT, task.category),
    SNAPSHOT_ROOT,
    "offline-largest-rename"
  );
  const calls: PilotRecord["mcpCalls"] = [];
  let client: McpStdioClient | undefined;
  try {
    client = await McpStdioClient.connect({
      allowedRoot: snapshot,
      requestTimeoutMs: MCP_TIMEOUT_MS,
    });
    const tools = await client.listTools();
    const schemaHash = toolSchemaFingerprint(tools);
    const listing = await checkedCall(
      client,
      calls,
      "list_directory_with_sizes",
      { path: snapshot, sortBy: "size" }
    );
    const jpgLines = textContent(listing)
      .split("\n")
      .filter((line) => JPG_LISTING_LINE.test(line));
    if (jpgLines.length < 1 || !SG_JPG.test(jpgLines[0])) {
      throw new Error(
        `MCP size inspection did not identify sg.jpg as the largest JPG: ${jpgLines.join(" | ")}`
      );
    }
    await checkedCall(client, calls, "move_file", {
      destination: join(snapshot, "largest.jpg"),
      source: join(snapshot, "sg.jpg"),
    });
    await client.close();
    client = undefined;
    const verification = runOfficialVerifier(
      task,
      snapshot,
      VERIFIER_TIMEOUT_MS
    );
    if (!verification.passed) {
      throw new Error(
        `largest_rename verifier failed: ${verification.stdout}\n${verification.stderr}`
      );
    }
    return {
      mcpCalls: calls,
      resultTreeHash: hashTree(snapshot),
      schemaHash,
      snapshot: KEEP ? snapshot : undefined,
      taskId: task.id,
      verification,
    };
  } finally {
    await client?.close();
    if (!KEEP) {
      rmSync(snapshot, { force: true, recursive: true });
    }
  }
}

async function runUppercase(
  task: OfficialFilesystemTask
): Promise<PilotRecord> {
  const snapshot = createPristineSnapshot(
    join(DATA_ROOT, task.category),
    SNAPSHOT_ROOT,
    "offline-uppercase"
  );
  const calls: PilotRecord["mcpCalls"] = [];
  let client: McpStdioClient | undefined;
  try {
    client = await McpStdioClient.connect({
      allowedRoot: snapshot,
      requestTimeoutMs: MCP_TIMEOUT_MS,
    });
    const tools = await client.listTools();
    const schemaHash = toolSchemaFingerprint(tools);
    const originalContents = new Map<string, string>();
    for (let index = 1; index <= 5; index += 1) {
      const filename = `file_${String(index).padStart(2, "0")}.txt`;
      const result = await checkedCall(client, calls, "read_text_file", {
        path: join(snapshot, filename),
      });
      originalContents.set(filename, textContent(result));
    }

    const uppercaseDirectory = join(snapshot, "uppercase");
    await checkedCall(client, calls, "create_directory", {
      path: uppercaseDirectory,
    });
    for (const [filename, content] of originalContents) {
      await checkedCall(client, calls, "write_file", {
        content: content.toUpperCase(),
        path: join(uppercaseDirectory, filename),
      });
    }
    await client.close();
    client = undefined;
    const verification = runOfficialVerifier(
      task,
      snapshot,
      VERIFIER_TIMEOUT_MS
    );
    if (!verification.passed) {
      throw new Error(
        `uppercase verifier failed: ${verification.stdout}\n${verification.stderr}`
      );
    }
    return {
      mcpCalls: calls,
      resultTreeHash: hashTree(snapshot),
      schemaHash,
      snapshot: KEEP ? snapshot : undefined,
      taskId: task.id,
      verification,
    };
  } finally {
    await client?.close();
    if (!KEEP) {
      rmSync(snapshot, { force: true, recursive: true });
    }
  }
}

async function main(): Promise<void> {
  console.log(
    "OFFLINE INFRASTRUCTURE SELF-TEST ONLY — no model/provider calls; not benchmark output"
  );
  const tasks = discoverOfficialEasyTasks(MCPMARK_ROOT);
  const largest = tasks.find(
    (task) => task.id === "file_property/largest_rename"
  );
  const uppercase = tasks.find((task) => task.id === "file_context/uppercase");
  if (!(largest && uppercase)) {
    throw new Error("Could not find both official pilot tasks");
  }

  const data = prepareFilesystemData(DATA_ROOT, [
    "file_context",
    "file_property",
  ]);
  const records = [
    await runLargestRename(largest),
    await runUppercase(uppercase),
  ];
  const schemaHashes = new Set(records.map((record) => record.schemaHash));
  if (schemaHashes.size !== 1) {
    throw new Error(
      `Filesystem MCP schema changed between pilot tasks: ${[...schemaHashes].join(", ")}`
    );
  }
  if (records.some((record) => !record.verification.passed)) {
    throw new Error("At least one official verifier failed");
  }

  const output = {
    data,
    generatedAt: new Date().toISOString(),
    kind: "offline-infrastructure-self-test",
    modelCalls: 0,
    mcpmarkCommit: MCPMARK_COMMIT,
    note: "This validates pinned data, MCP stdio setup, tool execution, isolation, and official verifiers. It is not a model benchmark score.",
    records,
    schemaHash: records[0].schemaHash,
    serverPackage: FILESYSTEM_MCP_PACKAGE,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `PASS largest_rename (${records[0].mcpCalls.length} MCP calls) and uppercase (${records[1].mcpCalls.length} MCP calls)`
  );
  console.log(`schema=${records[0].schemaHash} output=${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
