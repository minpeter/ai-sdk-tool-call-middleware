import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { createStreamJsonRecoveryTransform } from "../../../core/utils/stream-json-recovery";
import { createProtocolPartStream } from "../../protocols/shared/duplicate-harness";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../test-helpers";

type ToolCall = Extract<LanguageModelV4StreamPart, { type: "tool-call" }>;
type TextDelta = Extract<LanguageModelV4StreamPart, { type: "text-delta" }>;

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
];

const finishPart: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: stopFinishReason,
  usage: zeroUsage,
};

function textBlock(text: string, id = "t1"): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

function run(
  parts: readonly LanguageModelV4StreamPart[],
  configuredTools: LanguageModelV4FunctionTool[] = tools
): Promise<LanguageModelV4StreamPart[]> {
  return convertReadableStreamToArray(
    pipeWithTransformer(
      createProtocolPartStream(parts),
      createStreamJsonRecoveryTransform({ tools: configuredTools })
    )
  );
}

function selectToolCalls(
  parts: readonly LanguageModelV4StreamPart[]
): ToolCall[] {
  return parts.filter((part): part is ToolCall => part.type === "tool-call");
}

function requireToolCall(
  parts: readonly LanguageModelV4StreamPart[]
): ToolCall {
  const [call] = selectToolCalls(parts);
  if (call === undefined) {
    throw new TypeError("Expected recovered tool call");
  }
  return call;
}

function collectText(parts: readonly LanguageModelV4StreamPart[]): string {
  return parts
    .filter((part): part is TextDelta => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");
}

function runText(payload: string) {
  return run([...textBlock(payload), finishPart]);
}

async function expectSuppressed(payload: string): Promise<void> {
  const out = await runText(payload);
  expect(selectToolCalls(out)).toHaveLength(0);
  expect(collectText(out)).toBe("");
  expect(out).toEqual([finishPart]);
}

async function expectPlainText(payload: string): Promise<void> {
  const out = await runText(payload);
  expect(selectToolCalls(out)).toHaveLength(0);
  expect(collectText(out)).toBe(payload);
}

async function expectImmediateTextDeltas(deltas: readonly string[]) {
  const transformer = createStreamJsonRecoveryTransform({ tools });
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();

  // Deliberately close only after reads: output must arrive while still open.
  const writes = (async () => {
    await writer.write({ type: "text-start", id: "t1" });
    for (const delta of deltas) {
      await writer.write({ type: "text-delta", id: "t1", delta });
    }
  })();

  expect((await reader.read()).value).toMatchObject({ type: "text-start" });
  for (const delta of deltas) {
    expect((await reader.read()).value).toMatchObject({
      type: "text-delta",
      delta,
    });
  }
  await writes;
  await writer.close();
}

const sensitiveCases = [
  {
    name: "drops prototype-sensitive known-tool JSON blocks instead of flushing text",
    payload:
      '{"name":"get_weather","arguments":{"city":"Seoul","\\u0063onstructor":{"polluted":true}}}',
  },
  {
    name: "drops prototype-sensitive YAML tool-call blocks",
    payload:
      "<tool_call>\nname: get_weather\narguments:\n  constructor: true\n  city: Seoul\n</tool_call>",
  },
  {
    name: "drops prototype-sensitive single-tool argument blocks",
    payload: '{"city":"Seoul","constructor":{"polluted":true}}',
  },
];

describe("createStreamJsonRecoveryTransform", () => {
  it("recovers a bare JSON tool-call text block as a tool call", async () => {
    const out = await runText(
      '{"name":"get_weather","arguments":{"city":"Seoul"}}'
    );

    expect(out.map((part) => part.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);
    const toolCall = requireToolCall(out);
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });

    // tool-input lifecycle ids reconcile with the final toolCallId
    for (const part of out) {
      if ("id" in part && part.type.startsWith("tool-input")) {
        expect(part.id).toBe(toolCall.toolCallId);
      }
    }
  });

  it("recovers a bare JSON block split across many deltas", async () => {
    const payload = '{"name":"get_weather","arguments":{"city":"Seoul"}}';
    const deltas: LanguageModelV4StreamPart[] = Array.from(
      payload,
      (delta) => ({
        type: "text-delta",
        id: "t1",
        delta,
      })
    );
    const out = await run([
      { type: "text-start", id: "t1" },
      ...deltas,
      { type: "text-end", id: "t1" },
      finishPart,
    ]);

    expect(selectToolCalls(out).length).toBeGreaterThan(0);
    expect(collectText(out)).toBe("");
  });

  it("recovers multiple newline-separated bare JSON payloads", async () => {
    const out = await runText(
      '{"name":"get_weather","arguments":{"city":"Seoul"}}\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n{"name":"get_weather","arguments":{"city":"Paris"}}'
    );
    const calls = selectToolCalls(out);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => JSON.parse(call.input).city)).toEqual([
      "Seoul",
      "Tokyo",
      "Paris",
    ]);
    expect(collectText(out)).toBe("");
  });

  it("recovers an arguments-only object when a single tool is available", async () => {
    const toolCall = requireToolCall(await runText('{"city":"Seoul"}'));

    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });

  it("flushes an unknown-tool JSON block as plain text", async () => {
    const payload = '{"name":"unknown_tool","arguments":{"a":1}}';
    const out = await runText(payload);

    expect(selectToolCalls(out)).toHaveLength(0);
    expect(collectText(out)).toBe(payload);
    expect(out.map((part) => part.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  for (const testCase of sensitiveCases) {
    it(testCase.name, () => expectSuppressed(testCase.payload));
  }

  it("preserves trailing text after dropped sensitive JSON blocks", async () => {
    const out = await runText(
      '{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}} after'
    );

    expect(selectToolCalls(out)).toHaveLength(0);
    expect(collectText(out)).toBe(" after");
  });

  it("does not delay blocks that start with prose", () =>
    expectImmediateTextDeltas(["Hello ", "world"]));

  it("resolves a held block when the stream finishes without text-end", async () => {
    const out = await run([
      { type: "text-start", id: "t1" },
      {
        type: "text-delta",
        id: "t1",
        delta: '{"name":"get_weather","arguments":{"city":"Seoul"}}',
      },
      finishPart,
    ]);

    expect(selectToolCalls(out).length).toBeGreaterThan(0);
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("keeps leading whitespace blocks eligible for recovery", async () => {
    const out = await runText(
      '\n  {"name":"get_weather","arguments":{"city":"Seoul"}}\n'
    );
    expect(selectToolCalls(out).length).toBeGreaterThan(0);
  });

  it("keeps spaced Qwen function tags eligible for recovery", async () => {
    const toolCall = requireToolCall(
      await runText(
        '<function = "get_weather"><parameter=city>Seoul</parameter></function>'
      )
    );

    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });

  it("passes everything through when no tools are configured", async () => {
    const parts = [
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}'),
      finishPart,
    ];
    expect(await run(parts, [])).toEqual(parts);
  });
});

describe("createStreamJsonRecoveryTransform fenced blocks", () => {
  it("recovers a tool call from a fenced json block", async () => {
    const out = await runText(
      '```json\n{\n  "name": "get_weather",\n  "arguments": {"city": "Seoul"}\n}\n```'
    );
    const toolCall = requireToolCall(out);

    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
    expect(collectText(out)).toBe("");
  });

  it("flushes inline-code prose without holding it", () =>
    expectPlainText("`ls -la` lists files."));
});

describe("createStreamJsonRecoveryTransform extended hold shapes", () => {
  it("recovers an array-wrapped call list", async () => {
    const out = await runText(
      '[{"name":"get_weather","arguments":{"city":"Seoul"}}, {"name":"get_weather","arguments":{"city":"Tokyo"}}]'
    );

    expect(selectToolCalls(out)).toHaveLength(2);
    expect(collectText(out)).toBe("");
  });

  it("recovers a literal tool_call tag leaking through a foreign protocol", async () => {
    const out = await runText(
      '<tool_call>[{"name":"get_weather","arguments":{"city":"Seoul"}}]'
    );

    expect(selectToolCalls(out)).toHaveLength(1);
    expect(collectText(out)).toBe("");
  });

  it("flushes tag-like prose that is not a tool_call tag", () =>
    expectPlainText("<toolbox> content here"));
});

describe("createStreamJsonRecoveryTransform per-block independence (review fixes)", () => {
  it("recovers a second bare-JSON block after a successful recovery", async () => {
    const out = await run([
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}', "t1"),
      ...textBlock('{"name":"get_weather","arguments":{"city":"Tokyo"}}', "t2"),
      finishPart,
    ]);
    const calls = selectToolCalls(out);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.input).city)).toEqual([
      "Seoul",
      "Tokyo",
    ]);
    expect(collectText(out)).toBe("");
  });

  it("recovers a bare-JSON block even after a protocol tool call", async () => {
    const protocolToolCall: LanguageModelV4StreamPart = {
      type: "tool-call",
      toolCallId: "call_protocol",
      toolName: "get_weather",
      input: '{"city":"Paris"}',
    };
    const out = await run([
      protocolToolCall,
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}'),
      finishPart,
    ]);

    expect(selectToolCalls(out)).toHaveLength(2);
  });

  it("streams non-recoverable fenced blocks through without holding", () =>
    expectImmediateTextDeltas(["```python\nprint('hi')\n"]));

  it("flushes bracketed prose that is not an array of calls", () =>
    expectPlainText("[1] First citation in the list."));
});
