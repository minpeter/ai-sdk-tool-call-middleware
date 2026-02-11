import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { jsonProtocol } from "../src/core/protocols/json-protocol";
import { xmlProtocol } from "../src/core/protocols/xml-protocol";
import { yamlProtocol } from "../src/core/protocols/yaml-protocol";
import {
  xmlToolMiddleware,
  yamlToolMiddleware,
} from "../src/preconfigured-middleware";

const TOOL_CALL_ID_RE = /^call_[A-Za-z0-9]{24}$/;

const stopFinishReason = { unified: "stop", raw: "stop" } as const;
const zeroUsage = {
  inputTokens: {
    total: 0,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 0,
    text: undefined,
    reasoning: undefined,
  },
};

const weatherTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string" },
    },
    required: ["location"],
  },
};

const strictNameTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "bad_tool",
  description: "Strict tool",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    required: ["name"],
  },
};

const locationTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "get_location",
  description: "Get location",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const fileTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "write_file",
  description: "Write file",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      contents: { type: "string" },
    },
    required: ["file_path", "contents"],
  },
};

const tripTool: LanguageModelV3FunctionTool = {
  type: "function",
  name: "plan_trip",
  description: "Plan trip",
  inputSchema: {
    type: "object",
    properties: {
      location: { type: "string" },
      options: {
        type: "object",
        properties: {
          unit: { type: "string" },
        },
      },
      days: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["location"],
  },
};

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function checkOk(condition: boolean, message: string): void {
  if (!condition) {
    fail(message);
  }
}

function checkEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    fail(
      `${message}\nexpected: ${formatValue(expected)}\nactual: ${formatValue(actual)}`
    );
  }
}

function checkMatch(actual: string, pattern: RegExp, message: string): void {
  if (!pattern.test(actual)) {
    fail(`${message}\nvalue: ${actual}\npattern: ${pattern.toString()}`);
  }
}

function checkDeepEqual(
  actual: unknown,
  expected: unknown,
  message: string
): void {
  const actualText = formatValue(actual);
  const expectedText = formatValue(expected);
  if (actualText !== expectedText) {
    fail(`${message}\nexpected: ${expectedText}\nactual: ${actualText}`);
  }
}

function createTextDeltaStream(
  chunks: string[]
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "smoke",
          delta: chunk,
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

async function collect(
  parser: TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>,
  chunks: string[]
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = createTextDeltaStream(chunks).pipeThrough(parser).getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out.push(value);
  }
  return out;
}

function deltas(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter(
      (
        part
      ): part is Extract<
        LanguageModelV3StreamPart,
        { type: "tool-input-delta" }
      > => part.type === "tool-input-delta"
    )
    .map((part) => part.delta)
    .join("");
}

function text(parts: LanguageModelV3StreamPart[]): string {
  return parts
    .filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
        part.type === "text-delta"
    )
    .map((part) => part.delta)
    .join("");
}

function inputToText(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input);
}

function inputToObject(input: unknown): unknown {
  if (typeof input === "string") {
    return JSON.parse(input);
  }
  return input;
}

function single<T>(arr: T[], label: string): T {
  checkEqual(
    arr.length,
    1,
    `${label}: expected exactly one item, got ${arr.length}`
  );
  return arr[0] as T;
}

function toolCalls(
  parts: LanguageModelV3StreamPart[]
): Extract<LanguageModelV3StreamPart, { type: "tool-call" }>[] {
  return parts.filter(
    (part): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
      part.type === "tool-call"
  );
}

function verifySuccessfulToolStreaming(
  label: string,
  parts: LanguageModelV3StreamPart[],
  expectedInput: string,
  expectedToolName: string
) {
  const starts = parts.filter(
    (
      part
    ): part is Extract<
      LanguageModelV3StreamPart,
      { type: "tool-input-start" }
    > => part.type === "tool-input-start"
  );
  const ends = parts.filter(
    (
      part
    ): part is Extract<LanguageModelV3StreamPart, { type: "tool-input-end" }> =>
      part.type === "tool-input-end"
  );
  const calls = parts.filter(
    (part): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
      part.type === "tool-call"
  );

  const start = single(starts, `${label} tool-input-start`);
  const end = single(ends, `${label} tool-input-end`);
  const call = single(calls, `${label} tool-call`);

  checkEqual(start.toolName, expectedToolName, `${label} tool name mismatch`);
  checkEqual(start.id, end.id, `${label} start/end id mismatch`);
  checkEqual(call.toolCallId, start.id, `${label} tool call id mismatch`);
  checkMatch(
    call.toolCallId,
    TOOL_CALL_ID_RE,
    `${label} tool call id format mismatch`
  );
  checkEqual(
    inputToText(call.input),
    expectedInput,
    `${label} final input mismatch`
  );
  const joinedDeltas = deltas(parts);
  if (expectedInput === "{}" && joinedDeltas.length === 0) {
    // Some parsers emit no deltas for empty/self-closing arguments.
    console.log(`[PASS] ${label} empty-input delta shortcut`);
  } else {
    checkEqual(joinedDeltas, expectedInput, `${label} joined delta mismatch`);
  }

  console.log(`[PASS] ${label}`);
}

function verifyNoLeak(
  label: string,
  parts: LanguageModelV3StreamPart[],
  leakedMarker: string
) {
  const allText = text(parts);
  checkEqual(
    allText.includes(leakedMarker),
    false,
    `${label}: unexpected raw protocol leak: ${leakedMarker}`
  );
  console.log(`[PASS] ${label}`);
}

function verifyLeakWhenEnabled(
  label: string,
  parts: LanguageModelV3StreamPart[],
  leakedMarker: string
) {
  const allText = text(parts);
  checkEqual(
    allText.includes(leakedMarker),
    true,
    `${label}: expected raw protocol fallback marker`
  );
  console.log(`[PASS] ${label}`);
}

function verifyNoToolCall(label: string, parts: LanguageModelV3StreamPart[]) {
  const calls = parts.filter((part) => part.type === "tool-call");
  checkEqual(calls.length, 0, `${label}: expected no tool-call`);
  console.log(`[PASS] ${label}`);
}

function verifyNoDanglingToolInput(
  label: string,
  parts: LanguageModelV3StreamPart[]
) {
  const starts = parts.filter(
    (part) => part.type === "tool-input-start"
  ).length;
  const ends = parts.filter((part) => part.type === "tool-input-end").length;
  checkEqual(starts, ends, `${label}: dangling tool-input stream`);
  console.log(`[PASS] ${label}`);
}

function verifyToolCallCount(
  label: string,
  parts: LanguageModelV3StreamPart[],
  expectedCount: number
) {
  const calls = toolCalls(parts);
  checkEqual(
    calls.length,
    expectedCount,
    `${label}: expected ${expectedCount} tool-call(s), got ${calls.length}`
  );
  console.log(`[PASS] ${label}`);
}

function getUnifiedFinishReason(
  parts: LanguageModelV3StreamPart[]
): string | null {
  const finish = [...parts]
    .reverse()
    .find(
      (part): part is Extract<LanguageModelV3StreamPart, { type: "finish" }> =>
        part.type === "finish"
    );
  if (!finish) {
    return null;
  }
  const finishReason = finish.finishReason as unknown;
  if (typeof finishReason === "string") {
    return finishReason;
  }
  if (
    finishReason &&
    typeof finishReason === "object" &&
    "unified" in finishReason &&
    typeof (finishReason as { unified?: unknown }).unified === "string"
  ) {
    return (finishReason as { unified: string }).unified;
  }
  return null;
}

async function runLiveAiSdkSmoke(
  run: (name: string, fn: () => Promise<void>) => Promise<void>
) {
  if (!process.env.OPENAI_API_KEY) {
    console.log("[SKIP] LIVE AI-SDK smoke (OPENAI_API_KEY is not set)");
    return;
  }

  const modelId = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = [
    "Call the get_weather tool exactly once.",
    'Use arguments exactly: {"location":"Seoul","unit":"celsius"}.',
    "Do not output normal text before or after the tool call.",
  ].join("\\n");

  const liveTools = {
    get_weather: {
      description: "Get weather for a city",
      inputSchema: z.object({
        location: z.string(),
        unit: z.enum(["celsius", "fahrenheit"]),
      }),
    },
  };

  const collectLive = async (model: unknown, forceRequired = false) => {
    const result = streamText({
      model: model as Parameters<typeof streamText>[0]["model"],
      prompt,
      tools: liveTools,
      temperature: 0,
      stopWhen: stepCountIs(1),
      ...(forceRequired ? { toolChoice: "required" as const } : {}),
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of result.fullStream) {
      parts.push(part as LanguageModelV3StreamPart);
    }
    return parts;
  };

  await run("LIVE native OpenAI tool-calling stream", async () => {
    const parts = await collectLive(openai.chat(modelId), true);
    const calls = parts.filter(
      (
        part
      ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
    checkOk(calls.length >= 1, "native: expected at least one tool-call");
    const call = calls.at(-1) as Extract<
      LanguageModelV3StreamPart,
      { type: "tool-call" }
    >;
    checkEqual(call.toolName, "get_weather", "native: wrong tool name");
    checkOk(
      call.toolCallId.startsWith("call_"),
      "native: toolCallId must start with call_"
    );
    checkDeepEqual(inputToObject(call.input), {
      location: "Seoul",
      unit: "celsius",
    });
    console.log("[PASS] live native tool-call payload");
  });

  await run("LIVE OpenAI + xmlToolMiddleware stream", async () => {
    const parts = await collectLive(
      wrapLanguageModel({
        model: openai.chat(modelId),
        middleware: xmlToolMiddleware,
      })
    );
    verifySuccessfulToolStreaming(
      "live xml middleware",
      parts,
      '{"location":"Seoul","unit":"celsius"}',
      "get_weather"
    );
    const finish = getUnifiedFinishReason(parts);
    checkEqual(
      finish,
      "tool-calls",
      "live xml middleware: finishReason should be tool-calls"
    );
    console.log("[PASS] live xml middleware finishReason=tool-calls");
  });

  await run("LIVE OpenAI + yamlToolMiddleware stream", async () => {
    const parts = await collectLive(
      wrapLanguageModel({
        model: openai.chat(modelId),
        middleware: yamlToolMiddleware,
      })
    );
    verifySuccessfulToolStreaming(
      "live yaml middleware",
      parts,
      '{"location":"Seoul","unit":"celsius"}',
      "get_weather"
    );
    const finish = getUnifiedFinishReason(parts);
    checkEqual(
      finish,
      "tool-calls",
      "live yaml middleware: finishReason should be tool-calls"
    );
    console.log("[PASS] live yaml middleware finishReason=tool-calls");
  });
}

async function main() {
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, error: message });
      console.error(`[FAIL] ${name}`);
      console.error(message);
    }
  };

  await run("JSON streaming tool-call baseline", async () => {
    const parts = await collect(
      jsonProtocol().createStreamParser({ tools: [weatherTool] }),
      [
        "Before ",
        '<tool_call>{"na',
        'me":"get_weather","arg',
        'uments":{"location":"Seo',
        'ul","unit":"celsius"}}',
        "</tool_call>",
        " After",
      ]
    );

    verifySuccessfulToolStreaming(
      "json",
      parts,
      '{"location":"Seoul","unit":"celsius"}',
      "get_weather"
    );
  });

  await run("XML parsed-object delta streaming", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [weatherTool] }),
      [
        "Before ",
        "<get_weather>\n<location>Seo",
        "ul</location>\n<unit>ce",
        "lsius</unit>\n",
        "</get_weather>",
        " After",
      ]
    );

    verifySuccessfulToolStreaming(
      "xml",
      parts,
      '{"location":"Seoul","unit":"celsius"}',
      "get_weather"
    );
    verifyNoLeak("xml no raw markup leak", parts, "<get_weather>");
  });

  await run("XML start-tag split across chunks", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [weatherTool] }),
      [
        "Before ",
        "<get_",
        "weather><location>NY</location><unit>celsius</unit></get_weather>",
        " After",
      ]
    );

    verifySuccessfulToolStreaming(
      "xml split start tag",
      parts,
      '{"location":"NY","unit":"celsius"}',
      "get_weather"
    );
    verifyNoLeak("xml split start tag no leak", parts, "<get_weather>");
  });

  await run("XML closing tag with whitespace", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [weatherTool] }),
      ["<get_weather><location>SF</location></ get_weather>"]
    );

    verifySuccessfulToolStreaming(
      "xml whitespace closing tag",
      parts,
      '{"location":"SF"}',
      "get_weather"
    );
  });

  await run("XML self-closing tool call", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [locationTool] }),
      ["prefix ", "<get_location/>", " suffix"]
    );

    verifySuccessfulToolStreaming(
      "xml self closing",
      parts,
      "{}",
      "get_location"
    );
    verifyNoLeak("xml self closing no leak", parts, "<get_location");
  });

  await run("XML multiple tool calls in one stream", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [locationTool, weatherTool] }),
      [
        "<get_location/>",
        "<get_weather><location>Tokyo</location><unit>celsius</unit></get_weather>",
      ]
    );

    verifyToolCallCount("xml multiple tool calls count", parts, 2);
    const calls = toolCalls(parts);
    const first = calls[0] as Extract<
      LanguageModelV3StreamPart,
      { type: "tool-call" }
    >;
    const second = calls[1] as Extract<
      LanguageModelV3StreamPart,
      { type: "tool-call" }
    >;
    checkEqual(first.toolName, "get_location");
    checkEqual(inputToText(first.input), "{}");
    checkEqual(second.toolName, "get_weather");
    checkEqual(
      inputToText(second.input),
      '{"location":"Tokyo","unit":"celsius"}'
    );
    checkOk(
      first.toolCallId !== second.toolCallId,
      "xml multiple tool calls: toolCallId must be unique"
    );
    checkMatch(first.toolCallId, TOOL_CALL_ID_RE);
    checkMatch(second.toolCallId, TOOL_CALL_ID_RE);
    console.log("[PASS] xml multiple tool calls payload and ids");
  });

  await run("XML nested object/array payload streaming", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [tripTool] }),
      [
        "<plan_trip><location>Seoul</location><options><unit>celsius</unit></options>",
        "<days><item>mon</item><item>tue</item></days></plan_trip>",
      ]
    );

    verifyToolCallCount("xml nested payload count", parts, 1);
    const call = single(toolCalls(parts), "xml nested payload call");
    checkDeepEqual(inputToObject(call.input), {
      location: "Seoul",
      options: { unit: "celsius" },
      days: ["mon", "tue"],
    });
    checkEqual(deltas(parts), inputToText(call.input));
    console.log("[PASS] xml nested payload object equality");
  });

  await run("YAML parsed-object delta streaming (key split)", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [weatherTool] }),
      [
        "<get_weather>",
        "\n",
        "location: Seoul\nu",
        "nit: celsius\n",
        "</get_weather>",
      ]
    );

    verifySuccessfulToolStreaming(
      "yaml",
      parts,
      '{"location":"Seoul","unit":"celsius"}',
      "get_weather"
    );
    verifyNoLeak("yaml no raw markup leak", parts, "<get_weather>");
  });

  await run("YAML start-tag split across chunks", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [weatherTool] }),
      ["<get_wea", "ther>\nlocation: Berlin\n</get_weather>"]
    );

    verifySuccessfulToolStreaming(
      "yaml split start tag",
      parts,
      '{"location":"Berlin"}',
      "get_weather"
    );
  });

  await run("YAML self-closing tag with whitespace", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [locationTool] }),
      ["prefix ", "<get_location   />", " suffix"]
    );

    verifySuccessfulToolStreaming(
      "yaml self closing spaces",
      parts,
      "{}",
      "get_location"
    );
    verifyNoLeak("yaml self closing no leak", parts, "<get_location");
  });

  await run("YAML multiline block scalar payload", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [fileTool] }),
      [
        "<write_file>\n",
        "file_path: /tmp/demo.md\n",
        "contents: |\n",
        "  line one\n",
        "  line two\n",
        "</write_file>",
      ]
    );

    verifyToolCallCount("yaml multiline block count", parts, 1);
    const call = single(toolCalls(parts), "yaml multiline block call");
    checkDeepEqual(inputToObject(call.input), {
      file_path: "/tmp/demo.md",
      contents: "line one\nline two\n",
    });
    checkEqual(deltas(parts), inputToText(call.input));
    console.log("[PASS] yaml multiline block payload");
  });

  await run("YAML multiple tool calls in one stream", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [locationTool, weatherTool] }),
      [
        "<get_location/>",
        "<get_weather>\nlocation: Tokyo\nunit: celsius\n</get_weather>",
      ]
    );

    verifyToolCallCount("yaml multiple tool calls count", parts, 2);
    const calls = toolCalls(parts);
    checkEqual(calls[0]?.toolName, "get_location");
    checkEqual(inputToText(calls[0]?.input), "{}");
    checkEqual(calls[1]?.toolName, "get_weather");
    checkEqual(
      inputToText(calls[1]?.input),
      '{"location":"Tokyo","unit":"celsius"}'
    );
    checkMatch(
      (calls[0] as { toolCallId: string }).toolCallId,
      TOOL_CALL_ID_RE
    );
    checkMatch(
      (calls[1] as { toolCallId: string }).toolCallId,
      TOOL_CALL_ID_RE
    );
    console.log("[PASS] yaml multiple tool calls payload and ids");
  });

  await run("XML finish reconcile (unclosed but parseable)", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [weatherTool] }),
      ["<get_weather>\n<location>Bus", "an</location>\n<unit>celsius</unit>\n"]
    );

    verifySuccessfulToolStreaming(
      "xml reconcile",
      parts,
      '{"location":"Busan","unit":"celsius"}',
      "get_weather"
    );
  });

  await run("YAML finish reconcile (unclosed but parseable)", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [weatherTool] }),
      ["<get_weather>\nlocation: Busan\nunit: celsius\n"]
    );

    verifySuccessfulToolStreaming(
      "yaml reconcile",
      parts,
      '{"location":"Busan","unit":"celsius"}',
      "get_weather"
    );
  });

  await run("XML malformed finish default no-leak", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({ tools: [strictNameTool] }),
      ["<bad_tool><name>first</name><name>second</name>"]
    );

    verifyNoToolCall("xml malformed default", parts);
    verifyNoDanglingToolInput("xml malformed default", parts);
    verifyNoLeak("xml malformed default", parts, "<bad_tool>");
  });

  await run("XML malformed finish raw fallback opt-in", async () => {
    const parts = await collect(
      xmlProtocol().createStreamParser({
        tools: [strictNameTool],
        options: { emitRawToolCallTextOnError: true },
      }),
      ["<bad_tool><name>first</name><name>second</name>"]
    );

    verifyNoToolCall("xml malformed raw fallback", parts);
    verifyNoDanglingToolInput("xml malformed raw fallback", parts);
    verifyLeakWhenEnabled("xml malformed raw fallback", parts, "<bad_tool>");
  });

  await run("YAML malformed finish default no-leak", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({ tools: [weatherTool] }),
      ["<get_weather>\n["]
    );

    verifyNoToolCall("yaml malformed default", parts);
    verifyNoDanglingToolInput("yaml malformed default", parts);
    verifyNoLeak("yaml malformed default", parts, "<get_weather>");
  });

  await run("YAML malformed finish raw fallback opt-in", async () => {
    const parts = await collect(
      yamlProtocol().createStreamParser({
        tools: [weatherTool],
        options: { emitRawToolCallTextOnError: true },
      }),
      ["<get_weather>\n["]
    );

    verifyNoToolCall("yaml malformed raw fallback", parts);
    verifyNoDanglingToolInput("yaml malformed raw fallback", parts);
    verifyLeakWhenEnabled(
      "yaml malformed raw fallback",
      parts,
      "<get_weather>"
    );
  });

  if (process.argv.includes("--live")) {
    await runLiveAiSdkSmoke(run);
  }

  console.log("\n--- Smoke Summary ---");
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} - ${result.name}`);
  }

  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) {
    throw new Error(`Smoke test failed: ${failed} case(s) failed`);
  }

  console.log(`All ${results.length} streaming smoke cases passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
