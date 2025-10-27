import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import {
  type ModelMessage,
  stepCountIs,
  streamText,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";

// Provider: Friendli (same as XX-file-write example)
const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// Minimal file_write tool definition; execution is a no-op to avoid touching disk
const file_write = {
  description:
    "Write a text file to the local workspace. Always provide the FULL contents.",
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        "Relative path within the current workspace (e.g., 'src/main.ts', 'README.md')."
      ),
    content: z
      .string()
      .describe(
        "Full UTF-8 file contents to write (overwrites existing file)."
      ),
  }),
  execute: async ({ path, content }: { path: string; content: string }) => {
    // No-op execution; we only care about parsing the first tool call arguments
    return {
      ok: true,
      skippedWrite: true,
      bytes: Buffer.byteLength(content, "utf8"),
      path,
    };
  },
};

type FirstToolCall = {
  toolName: string;
  input: unknown;
};

async function runOnce(
  _runIndex: number
): Promise<{ ok: boolean; detail: string; first?: FirstToolCall }> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "You are a helpful code assistant. When the user asks to create or modify files, use the file_write tool. Always write complete file contents. Keep explanations concise.",
    },
    { role: "user", content: "test.html를 만들어줘" },
  ];

  const result = streamText({
    model: wrapLanguageModel({
      model: friendli("google/gemma-3-27b-it"),
      middleware: morphXmlToolMiddleware,
    }),
    temperature: 0.0,
    messages,
    // Focus on the very first tool call in this turn
    stopWhen: stepCountIs(6),
    tools: { file_write },
  });

  let lastToolCall: FirstToolCall | undefined;

  for await (const part of result.fullStream) {
    if (part.type === "tool-call") {
      const rawInput = part.input;
      const parsed =
        typeof rawInput === "string" ? safeJsonParse(rawInput) : rawInput;
      lastToolCall = { toolName: part.toolName, input: parsed };
    }
  }

  if (!lastToolCall) {
    return { ok: false, detail: "No tool-call detected" };
  }

  const verdict = analyzeFileWriteInput(lastToolCall.input);
  return { ok: verdict.ok, detail: verdict.detail, first: lastToolCall };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function analyzeFileWriteInput(input: unknown): {
  ok: boolean;
  detail: string;
} {
  if (!input || typeof input !== "object") {
    return { ok: false, detail: "Input is not an object" };
  }

  const obj = input as Record<string, unknown>;
  const path = obj.path;
  const content = obj.content;

  if (typeof path !== "string" || typeof content !== "string") {
    return { ok: false, detail: "Missing or invalid path/content" };
  }

  // Heuristics: ensure we didn't truncate to just "!DOCTYPE html"
  const looksLikeHtml =
    /<!DOCTYPE\s+html/i.test(content) || /<html[\s>]/i.test(content);
  const hasHtmlEnd = /<\/html>/i.test(content);
  const hasMeaningfulBody =
    /<body[\s>][\s\S]*?<\/body>/i.test(content) || /<h1[\s>]/i.test(content);
  const notTruncated = content.trim().length > 50;

  const ok = looksLikeHtml && (hasHtmlEnd || hasMeaningfulBody) && notTruncated;
  const detail = ok
    ? "Parsed full HTML content"
    : `contentTooShort=${!notTruncated}, hasDoctypeOrHtml=${looksLikeHtml}, hasEndHtmlOrBody=${hasHtmlEnd || hasMeaningfulBody}`;
  return { ok, detail };
}

async function main() {
  console.log("Debug: Starting 3 runs with prompt 'test.html를 만들어줘'\n");
  const results = [] as Array<{
    ok: boolean;
    detail: string;
    first?: FirstToolCall;
  }>;
  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- Run ${i} ---`);
    const outcome = await runOnce(i);
    results.push(outcome);
    if (outcome.first) {
      const input = outcome.first.input as Record<string, unknown>;
      const sample =
        typeof input?.content === "string"
          ? (input.content as string).slice(0, 120)
          : String(input?.content);
      console.log(`First tool-call: ${outcome.first.toolName}`);
      console.log(`Path: ${String(input?.path)}`);
      console.log(`Content (head): ${sample.replace(/\n/g, "\\n")}...`);
    }
    console.log(`Verdict: ${outcome.ok ? "PASS" : "FAIL"} (${outcome.detail})`);
  }

  const passCount = results.filter((r) => r.ok).length;
  console.log(`\nSummary: ${passCount}/3 runs passed.`);
  process.exit(passCount === 3 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
