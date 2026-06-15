import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

// Regression guard for #336: the non-streaming (`parseGeneratedText`) and
// streaming (`createStreamParser`) Hermes paths now share a single tool-call
// resolver (`resolveToolCall`). For any input the two paths must agree on the
// tool calls they ultimately produce. These tests feed identical text to both
// paths (the whole string at once to streaming) and assert the emitted tool
// calls — normalized to `{ toolName, input }` with the input re-parsed so the
// random tool-call ids do not matter — are equal.

function makeTool(
  name: string,
  properties: Record<string, { type: string }>,
  additionalProperties?: boolean
): LanguageModelV3FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: {
      type: "object",
      properties,
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    },
  };
}

interface NormalizedToolCall {
  input: unknown;
  toolName: string;
}

function normalize(input: string, toolName: string): NormalizedToolCall {
  let parsed: unknown = input;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = input;
  }
  return { toolName, input: parsed };
}

function nonStreamingToolCalls(
  text: string,
  tools: LanguageModelV3FunctionTool[]
): NormalizedToolCall[] {
  const protocol = hermesProtocol();
  return protocol
    .parseGeneratedText({ text, tools })
    .filter((c) => c.type === "tool-call")
    .map((c) => normalize((c as { input: string }).input, c.toolName));
}

async function streamingToolCalls(
  text: string,
  tools: LanguageModelV3FunctionTool[]
): Promise<NormalizedToolCall[]> {
  const protocol = hermesProtocol();
  const transformer = protocol.createStreamParser({ tools });
  const rs = new ReadableStream<LanguageModelV3StreamPart>({
    start(ctrl) {
      ctrl.enqueue({ type: "text-delta", id: "1", delta: text });
      ctrl.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      ctrl.close();
    },
  });
  const out = await convertReadableStreamToArray(
    pipeWithTransformer(rs, transformer)
  );
  return out
    .filter((c) => c.type === "tool-call")
    .map((c) => normalize((c as { input: string }).input, c.toolName));
}

const writeTool = makeTool("write", {
  path: { type: "string" },
  content: { type: "string" },
});

const strictTool = makeTool("search", { query: { type: "string" } }, false);

const cases: Array<{
  name: string;
  text: string;
  tools: LanguageModelV3FunctionTool[];
}> = [
  {
    name: "single valid tool call",
    text: '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>',
    tools: [],
  },
  {
    name: "end tag inside a JSON string value",
    text: '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>',
    tools: [],
  },
  {
    name: "two adjacent calls; first holds an inner end tag in a string",
    text:
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}}</tool_call>' +
      '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
    tools: [],
  },
  {
    name: "valid call recovered after an unclosed/malformed first call",
    text:
      '<tool_call>{"name":"bash","arguments":{"cmd":"x </tool_call> y"}} ' +
      '<tool_call>{"name":"ok","arguments":{}}</tool_call>',
    tools: [],
  },
  {
    name: "surrounding text with two well-formed calls",
    text:
      "before " +
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      " middle " +
      '<tool_call>{"name":"b","arguments":{"n":1}}</tool_call>' +
      " after",
    tools: [],
  },
  {
    name: "unescaped quotes repaired via shared resolver",
    text: '<tool_call>{"name":"write","arguments":{"path":"/tmp/a.txt","content":"use "strict"; var x = 1;"}}</tool_call>',
    tools: [writeTool],
  },
  {
    name: "schema-aware coercion of a stringified number",
    text: '<tool_call>{"name":"search","arguments":{"query":"hello"}}</tool_call>',
    tools: [strictTool],
  },
  {
    name: "schema-unknown key dropped under strict additionalProperties:false",
    text: '<tool_call>{"name":"search","arguments":{"query":"hi","extra":"nope"}}</tool_call>',
    tools: [strictTool],
  },
  {
    name: "prototype-sensitive key dropped",
    text: '<tool_call>{"name":"bash","arguments":{"__proto__":{"polluted":true}}}</tool_call>',
    tools: [],
  },
  {
    name: "malformed body dropped",
    text: "<tool_call>{not valid json at all</tool_call>",
    tools: [],
  },
];

describe("hermesProtocol – streaming/non-streaming tool-call resolution parity", () => {
  it.each(cases)("produces identical tool calls for both paths: $name", async ({
    text,
    tools,
  }) => {
    const nonStreaming = nonStreamingToolCalls(text, tools);
    const streaming = await streamingToolCalls(text, tools);
    expect(streaming).toEqual(nonStreaming);
  });
});
