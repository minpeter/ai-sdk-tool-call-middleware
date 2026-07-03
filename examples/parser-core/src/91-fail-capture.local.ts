/** Local-only: re-run failing matrix combos capturing full raw payloads. */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, type ToolSet, wrapLanguageModel } from "ai";
import { z } from "zod";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  qwen3CoderToolMiddleware,
  yamlXmlToolMiddleware,
} from "../../../src/preconfigured-middleware";

const provider = createOpenAICompatible({
  name: "freerouter",
  apiKey: "fr-good-vibe-only",
  baseURL: "https://freerouter.minpeter.workers.dev/v1",
});

const MIDDLEWARES = {
  hermes: hermesToolMiddleware,
  morphXml: morphXmlToolMiddleware,
  qwen3Coder: qwen3CoderToolMiddleware,
  yamlXml: yamlXmlToolMiddleware,
} as const;

const writeFileTools: ToolSet = {
  write_file: {
    description: "Write a source file.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string().describe("Full file content, verbatim."),
    }),
  },
};

const twoTools: ToolSet = {
  list_dir: {
    description: "List files in a directory.",
    inputSchema: z.object({ path: z.string() }),
  },
  read_file: {
    description: "Read a file.",
    inputSchema: z.object({ path: z.string() }),
  },
};

const sendTools: ToolSet = {
  send_message: {
    description: "Send a chat message.",
    inputSchema: z.object({
      recipient: z.string(),
      body: z.string().describe("Message body, verbatim."),
    }),
  },
};

const LONGCODE_PROMPT =
  'Write a Python file fizzbuzz.py: a function fizzbuzz(n) returning "Fizz"/"Buzz"/"FizzBuzz"/str(n), plus a __main__ loop printing 1..30. Include a docstring with the words "classic interview question". Use write_file once with the complete file.';
const TWO_TOOLS_PROMPT =
  "First list the directory /src, then read /src/main.ts. Issue both tool calls now, in this single turn.";
const UNICODE_PROMPT =
  'Send the message "안녕하세요! 오늘 회의는 3시입니다 🚀 <중요>" to 민석. Use send_message with the body exactly as quoted.';

type Combo = {
  model: string;
  mw: keyof typeof MIDDLEWARES;
  mode: "stream" | "gen";
  tools: ToolSet;
  prompt: string;
  label: string;
};

const combos: Combo[] = [
  { label: "CRASH qwen2.5 stream-longcode", model: "qwen/qwen2.5-7b-instruct", mw: "qwen3Coder", mode: "stream", tools: writeFileTools, prompt: LONGCODE_PROMPT },
  { label: "glm variants gen-unicode", model: "zai-org/glm-4.7", mw: "qwen3Coder", mode: "gen", tools: sendTools, prompt: UNICODE_PROMPT },
  { label: "glm stream-two-tools", model: "zai-org/glm-4.7", mw: "qwen3Coder", mode: "stream", tools: twoTools, prompt: TWO_TOOLS_PROMPT },
  { label: "glm stream-longcode", model: "zai-org/glm-4.7", mw: "qwen3Coder", mode: "stream", tools: writeFileTools, prompt: LONGCODE_PROMPT },
  { label: "mistral hermes stream-longcode", model: "mistralai/mistral-small-latest", mw: "hermes", mode: "stream", tools: writeFileTools, prompt: LONGCODE_PROMPT },
  { label: "mistral yaml stream-longcode", model: "mistralai/mistral-small-latest", mw: "yamlXml", mode: "stream", tools: writeFileTools, prompt: LONGCODE_PROMPT },
  { label: "granite yaml stream-longcode", model: "ibm-granite/granite-4.0-h-micro", mw: "yamlXml", mode: "stream", tools: writeFileTools, prompt: LONGCODE_PROMPT },
  { label: "granite hermes stream-two-tools", model: "ibm-granite/granite-4.0-h-micro", mw: "hermes", mode: "stream", tools: twoTools, prompt: TWO_TOOLS_PROMPT },
  { label: "qwen2.5 qwen3Coder gen-unicode", model: "qwen/qwen2.5-7b-instruct", mw: "qwen3Coder", mode: "gen", tools: sendTools, prompt: UNICODE_PROMPT },
];

function onErrorOpts(errors: string[]) {
  return {
    toolCallMiddleware: {
      onError: (message: string, metadata?: Record<string, unknown>) => {
        errors.push(`${message}\n  META: ${JSON.stringify(metadata)}`);
      },
    },
  };
}

async function runCombo(c: Combo) {
  const errors: string[] = [];
  console.log(`\n########## ${c.label} [${c.model} ${c.mw} ${c.mode}]`);
  try {
    if (c.mode === "gen") {
      const result = await generateText({
        model: wrapLanguageModel({ model: provider(c.model), middleware: MIDDLEWARES[c.mw] }),
        tools: c.tools,
        prompt: c.prompt,
        providerOptions: onErrorOpts(errors),
        abortSignal: AbortSignal.timeout(120_000),
      });
      console.log("toolCalls:", JSON.stringify(result.toolCalls, null, 1).slice(0, 1500));
      console.log("text:", JSON.stringify(result.text.slice(0, 500)));
      console.log("finish:", result.finishReason);
    } else {
      const result = streamText({
        model: wrapLanguageModel({ model: provider(c.model), middleware: MIDDLEWARES[c.mw] }),
        tools: c.tools,
        prompt: c.prompt,
        providerOptions: onErrorOpts(errors),
        includeRawChunks: true,
        abortSignal: AbortSignal.timeout(120_000),
      });
      let rawText = "";
      const summary: string[] = [];
      for await (const part of result.fullStream) {
        summary.push(part.type);
        if (part.type === "raw") {
          const rc = part.rawValue as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          rawText += rc?.choices?.[0]?.delta?.content ?? "";
        }
        if (part.type === "error") {
          console.log("STREAM ERROR:", part.error instanceof Error ? part.error.stack : String(part.error));
        }
        if (part.type === "tool-call") {
          console.log("tool-call:", JSON.stringify(part).slice(0, 600));
        }
      }
      console.log("finish:", await result.finishReason);
      console.log("text:", JSON.stringify((await result.text).slice(0, 400)));
      console.log("RAW MODEL TEXT >>>");
      console.log(rawText.slice(0, 4000));
      console.log("<<< END RAW");
    }
  } catch (error) {
    console.log("THROWN:", error instanceof Error ? error.stack : String(error));
  }
  for (const e of errors) {
    console.log("onError:", e.slice(0, 3000));
  }
}

for (const c of combos) {
  await runCombo(c);
}
