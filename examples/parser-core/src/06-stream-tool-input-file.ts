import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { morphXmlToolMiddleware } from "../../../src/preconfigured-middleware";

const TOOL_COLOR = "\x1b[36m";
const INFO_COLOR = "\x1b[90m";
const REASONING_COLOR = "\x1b[33m";
const RESET_COLOR = "\x1b[0m";

const MAX_STEPS = 1;
const OUTPUT_DIR = path.resolve(process.cwd(), ".demo-output");

const openrouterApiKey = process.env.OPENROUTER_API_KEY;

if (!openrouterApiKey) {
  throw new Error("Set OPENROUTER_API_KEY before running this demo.");
}

const model = createOpenAICompatible({
  name: "openrouter",
  apiKey: openrouterApiKey,
  baseURL: "https://openrouter.ai/api/v1",
})("arcee-ai/trinity-large-preview:free");

const prompt = [
  "Call write_markdown_file exactly once.",
  "Use file_path: stream-tool-input-visual-demo.md",
  "Create medium-length markdown content with 8 headings, two bullet lists, and two fenced code blocks.",
  "Keep the content around 320 to 420 words.",
  "Do not call the tool more than once.",
].join("\n");

interface ToolInputState {
  inputText: string;
  toolName: string;
}
interface StreamState {
  didPrintReasoning: boolean;
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
  const maxLen = 140;
  if (inputText.length <= maxLen) {
    return inputText;
  }
  return `${inputText.slice(0, maxLen)}...`;
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

function handleReasoningDelta(
  part: Extract<FullStreamPart, { type: "reasoning-delta" }>,
  state: StreamState
) {
  if (!state.didPrintReasoning) {
    printSection("Reasoning");
    state.didPrintReasoning = true;
  }
  process.stdout.write(`${REASONING_COLOR}${part.text}${RESET_COLOR}`);
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
    case "reasoning-delta": {
      handleReasoningDelta(part, state);
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
  printSection("Streaming Tool Input Visual Demo");
  console.log(
    `${INFO_COLOR}Watching tool-input stream for a file-write tool call...${RESET_COLOR}`
  );

  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: morphXmlToolMiddleware,
    }),
    stopWhen: stepCountIs(MAX_STEPS),
    prompt,
    tools: {
      write_markdown_file: {
        description:
          "Write a markdown file. Use this when the user asks for a generated document.",
        inputSchema: z.object({
          file_path: z.string().describe("Target file name"),
          content: z.string().describe("Markdown content to write"),
        }),
        execute: async ({ file_path, content }) => {
          await mkdir(OUTPUT_DIR, { recursive: true });
          const safeName = path.basename(file_path);
          const fullPath = path.join(OUTPUT_DIR, safeName);
          await writeFile(fullPath, content, "utf8");

          return {
            saved_to: fullPath,
            bytes: Buffer.byteLength(content, "utf8"),
            lines: content.split("\n").length,
            preview: content.slice(0, 180),
          };
        },
      },
    },
  });

  const toolInputById = new Map<string, ToolInputState>();
  const state: StreamState = {
    didPrintReasoning: false,
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
  if (didPrintAssistantText || state.didPrintReasoning) {
    process.stdout.write("\n");
  }

  printSection("Complete");
  console.log(`${INFO_COLOR}Demo output folder: ${OUTPUT_DIR}${RESET_COLOR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
