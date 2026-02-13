import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { yamlToolMiddleware } from "../../../src/preconfigured-middleware";

const TOOL_COLOR = "\x1b[36m";
const INFO_COLOR = "\x1b[90m";
const RESET_COLOR = "\x1b[0m";

const MAX_STEPS = 1;
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  "examples/parser-core/.demo-output"
);

const openrouterApiKey = process.env.OPENROUTER_API_KEY;

if (!openrouterApiKey) {
  throw new Error("Set OPENROUTER_API_KEY before running this demo.");
}

const model = createOpenAICompatible({
  name: "openrouter",
  apiKey: openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
})(process.env.OPENROUTER_MODEL ?? "arcee-ai/trinity-large-preview:free");

const prompt = [
  "Call submit_release_bundle exactly once.",
  "Use request_id: release-bundle-2026-02-14.",
  "Fill every field in the schema with realistic values.",
  "Include all nested arrays and nested objects.",
  "Do not call the tool more than once.",
].join("\n");

interface ToolInputState {
  toolName: string;
  inputText: string;
}

interface StreamState {
  sawToolInput: boolean;
}

type FullStreamPart =
  Awaited<ReturnType<typeof streamText>>["fullStream"] extends AsyncIterable<
    infer T
  >
    ? T
    : never;

function printSection(title: string) {
  console.log(`\n${INFO_COLOR}=== ${title} ===${RESET_COLOR}`);
}

function summarizeToolInput(inputText: string): string {
  const maxLen = 180;
  if (inputText.length <= maxLen) {
    return inputText;
  }
  return `${inputText.slice(0, maxLen)}...`;
}

function countLeafNodes(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countLeafNodes(item), 0);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce(
      (count, item) => count + countLeafNodes(item),
      0
    );
  }
  return 1;
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

function handleToolInputStart(
  part: Extract<FullStreamPart, { type: "tool-input-start" }>,
  toolInputById: Map<string, ToolInputState>,
  state: StreamState
) {
  state.sawToolInput = true;
  toolInputById.set(part.id, { toolName: part.toolName, inputText: "" });
  printSection(`tool-input-start: ${part.toolName}`);
  process.stdout.write(`${INFO_COLOR}id=${part.id}${RESET_COLOR}\n`);
  process.stdout.write(TOOL_COLOR);
}

function handleToolInputDelta(
  part: Extract<FullStreamPart, { type: "tool-input-delta" }>,
  toolInputById: Map<string, ToolInputState>
) {
  const state = toolInputById.get(part.id);
  if (state) {
    state.inputText += part.delta;
  }
  process.stdout.write(part.delta);
}

function handleToolInputEnd(
  part: Extract<FullStreamPart, { type: "tool-input-end" }>,
  toolInputById: Map<string, ToolInputState>
) {
  process.stdout.write(`${RESET_COLOR}\n`);
  const state = toolInputById.get(part.id);
  if (!state) {
    return;
  }

  printSection(`tool-input-end: ${state.toolName}`);
  console.log({
    id: part.id,
    bytes: state.inputText.length,
    preview: summarizeToolInput(state.inputText),
  });
}

function handleToolCall(
  part: Extract<FullStreamPart, { type: "tool-call" }>,
  toolInputById: Map<string, ToolInputState>,
  state: StreamState
) {
  state.sawToolInput = true;
  printSection(`tool-call: ${part.toolName}`);
  const toolState = toolInputById.get(part.toolCallId);
  console.log({
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    inputBytes: toolState?.inputText.length,
  });
}

function handleStreamPart(
  part: FullStreamPart,
  toolInputById: Map<string, ToolInputState>,
  state: StreamState
) {
  switch (part.type) {
    case "tool-input-start": {
      handleToolInputStart(part, toolInputById, state);
      return;
    }
    case "tool-input-delta": {
      handleToolInputDelta(part, toolInputById);
      return;
    }
    case "tool-input-end": {
      handleToolInputEnd(part, toolInputById);
      return;
    }
    case "tool-call": {
      handleToolCall(part, toolInputById, state);
      return;
    }
    case "tool-result": {
      printSection(`tool-result: ${part.toolName}`);
      console.log({
        toolCallId: part.toolCallId,
        output: part.output,
      });
      return;
    }
    case "finish-step": {
      console.log(
        `${INFO_COLOR}[finish-step] reason=${part.finishReason}${RESET_COLOR}`
      );
      return;
    }
    case "finish": {
      console.log(
        `${INFO_COLOR}[finish] reason=${part.finishReason}${RESET_COLOR}`
      );
      return;
    }
    default:
      return;
  }
}

async function main() {
  printSection("Streaming Tool Input Visual Demo (Many Params)");
  console.log(
    `${INFO_COLOR}Watching tool-input stream for a many-parameter nested payload...${RESET_COLOR}`
  );

  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: yamlToolMiddleware,
    }),
    stopWhen: stepCountIs(MAX_STEPS),
    prompt,
    tools: {
      submit_release_bundle: {
        description:
          "Submit a release bundle with many top-level and nested parameters for deployment orchestration.",
        inputSchema: z.object({
          request_id: z.string().describe("Unique release request id"),
          service_name: z.string().describe("Service being released"),
          release_version: z.string().describe("Semantic version"),
          environment: z
            .enum(["staging", "production"])
            .describe("Target environment"),
          release_window: z.object({
            start_at: z.string(),
            end_at: z.string(),
            timezone: z.string(),
          }),
          ownership: z.object({
            release_manager: z.string(),
            on_call_engineer: z.string(),
            approvers: z.array(
              z.object({
                name: z.string(),
                team: z.string(),
                approved_at: z.string(),
              })
            ),
          }),
          change_summary: z.object({
            headline: z.string(),
            objectives: z.array(z.string()),
            impacted_domains: z.array(z.string()),
            risk_level: z.enum(["low", "medium", "high"]),
          }),
          artifacts: z.array(
            z.object({
              name: z.string(),
              version: z.string(),
              checksum_sha256: z.string(),
              source_uri: z.string(),
            })
          ),
          deployment_plan: z.object({
            strategy: z.enum(["rolling", "blue-green", "canary"]),
            max_unavailable: z.number(),
            steps: z.array(
              z.object({
                order: z.number(),
                action: z.string(),
                owner: z.string(),
              })
            ),
          }),
          rollback_plan: z.object({
            trigger_conditions: z.array(z.string()),
            data_restore: z.object({
              required: z.boolean(),
              backup_reference: z.string(),
              rpo_minutes: z.number(),
            }),
            steps: z.array(z.string()),
          }),
          validation_suite: z.object({
            smoke_tests: z.array(z.string()),
            regression_groups: z.array(z.string()),
            performance_budget: z.object({
              p95_latency_ms: z.number(),
              error_rate_percent: z.number(),
            }),
            security_checks: z.array(z.string()),
          }),
          communication_plan: z.object({
            channels: z.array(z.string()),
            stakeholders: z.array(
              z.object({
                name: z.string(),
                role: z.string(),
                notify_via: z.string(),
              })
            ),
            customer_notice: z.object({
              required: z.boolean(),
              template_id: z.string(),
              scheduled_at: z.string(),
            }),
          }),
          observability: z.object({
            dashboards: z.array(z.string()),
            alerts: z.array(
              z.object({
                metric: z.string(),
                threshold: z.string(),
                window: z.string(),
                severity: z.enum(["info", "warning", "critical"]),
              })
            ),
            success_criteria: z.array(z.string()),
          }),
          compliance: z.object({
            change_ticket: z.string(),
            freeze_exception: z.boolean(),
            approvals: z.array(
              z.object({
                name: z.string(),
                team: z.string(),
                approved_at: z.string(),
              })
            ),
          }),
          metadata: z.object({
            created_by: z.string(),
            created_at: z.string(),
            tags: z.array(z.string()),
            notes: z.string(),
          }),
        }),
        execute: async (input) => {
          await mkdir(OUTPUT_DIR, { recursive: true });
          const safeName = toSafeFileName(input.request_id);
          const fullPath = path.join(OUTPUT_DIR, `${safeName}.json`);
          const serialized = `${JSON.stringify(input, null, 2)}\n`;
          await writeFile(fullPath, serialized, "utf8");

          return {
            saved_to: fullPath,
            top_level_keys: Object.keys(input).length,
            leaf_nodes: countLeafNodes(input),
            bytes: Buffer.byteLength(serialized, "utf8"),
            preview: serialized.slice(0, 220),
          };
        },
      },
    },
  });

  const toolInputById = new Map<string, ToolInputState>();
  const state: StreamState = {
    sawToolInput: false,
  };
  let didPrintAssistantText = false;

  const fullStreamTask = (async () => {
    for await (const part of result.fullStream) {
      handleStreamPart(part, toolInputById, state);
    }
  })();

  const textStreamTask = (async () => {
    for await (const textPart of result.textStream) {
      if (!didPrintAssistantText) {
        printSection("Assistant Text");
        didPrintAssistantText = true;
      }
      process.stdout.write(textPart);
    }
  })();

  await Promise.all([fullStreamTask, textStreamTask]);
  if (didPrintAssistantText) {
    process.stdout.write("\n");
  }

  printSection("Complete");
  console.log(`${INFO_COLOR}Demo output folder: ${OUTPUT_DIR}${RESET_COLOR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
