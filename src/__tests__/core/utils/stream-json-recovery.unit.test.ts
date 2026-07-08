import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { createStreamJsonRecoveryTransform } from "../../../core/utils/stream-json-recovery";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../test-helpers";

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

function streamOf(
  parts: LanguageModelV4StreamPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function textBlock(text: string, id = "t1"): LanguageModelV4StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

async function run(
  parts: LanguageModelV4StreamPart[]
): Promise<LanguageModelV4StreamPart[]> {
  return await convertReadableStreamToArray(
    pipeWithTransformer(
      streamOf(parts),
      createStreamJsonRecoveryTransform({ tools })
    )
  );
}

describe("createStreamJsonRecoveryTransform", () => {
  it("recovers a bare JSON tool-call text block as a tool call", async () => {
    const out = await run([
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}'),
      finishPart,
    ]);

    const types = out.map((p) => p.type);
    expect(types).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);

    const toolCall = out.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
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
    const deltas: LanguageModelV4StreamPart[] = payload
      .split("")
      .map((ch) => ({ type: "text-delta", id: "t1", delta: ch }));

    const out = await run([
      { type: "text-start", id: "t1" },
      ...deltas,
      { type: "text-end", id: "t1" },
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(true);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
  });

  it("recovers multiple newline-separated bare JSON payloads", async () => {
    const out = await run([
      ...textBlock(
        '{"name":"get_weather","arguments":{"city":"Seoul"}}\n{"name":"get_weather","arguments":{"city":"Tokyo"}}\n{"name":"get_weather","arguments":{"city":"Paris"}}'
      ),
      finishPart,
    ]);

    const calls = out.filter((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >[];
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
      "Paris",
    ]);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
  });

  it("recovers an arguments-only object when a single tool is available", async () => {
    const out = await run([...textBlock('{"city":"Seoul"}'), finishPart]);

    const toolCall = out.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });

  it("flushes an unknown-tool JSON block as plain text", async () => {
    const payload = '{"name":"unknown_tool","arguments":{"a":1}}';
    const out = await run([...textBlock(payload), finishPart]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const deltas = out.filter((p) => p.type === "text-delta");
    expect(deltas.map((d) => (d as { delta: string }).delta).join("")).toBe(
      payload
    );
    expect(out.map((p) => p.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
  });

  it("drops prototype-sensitive known-tool JSON blocks instead of flushing text", async () => {
    const out = await run([
      ...textBlock(
        '{"name":"get_weather","arguments":{"city":"Seoul","\\u0063onstructor":{"polluted":true}}}'
      ),
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
    expect(out).toEqual([finishPart]);
  });

  it("preserves trailing text after dropped sensitive JSON blocks", async () => {
    const out = await run([
      ...textBlock(
        '{"name":"get_weather","arguments":{"city":"Seoul","constructor":{"polluted":true}}} after'
      ),
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe(" after");
  });

  it("drops prototype-sensitive YAML tool-call blocks", async () => {
    const out = await run([
      ...textBlock(
        "<tool_call>\nname: get_weather\narguments:\n  constructor: true\n  city: Seoul\n</tool_call>"
      ),
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
    expect(out).toEqual([finishPart]);
  });

  it("drops prototype-sensitive single-tool argument blocks", async () => {
    const out = await run([
      ...textBlock('{"city":"Seoul","constructor":{"polluted":true}}'),
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
    expect(out).toEqual([finishPart]);
  });

  it("does not delay blocks that start with prose", async () => {
    const transformer = createStreamJsonRecoveryTransform({ tools });
    const writer = transformer.writable.getWriter();
    const reader = transformer.readable.getReader();

    // Deliberately no close(): the parts must be readable while the stream
    // is still open, otherwise prose would be buffered until flush.
    const writes = (async () => {
      await writer.write({ type: "text-start", id: "t1" });
      await writer.write({ type: "text-delta", id: "t1", delta: "Hello " });
      await writer.write({ type: "text-delta", id: "t1", delta: "world" });
    })();

    expect((await reader.read()).value).toMatchObject({ type: "text-start" });
    expect((await reader.read()).value).toMatchObject({
      type: "text-delta",
      delta: "Hello ",
    });
    expect((await reader.read()).value).toMatchObject({
      type: "text-delta",
      delta: "world",
    });

    await writes;
    await writer.close();
  });

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

    expect(out.some((p) => p.type === "tool-call")).toBe(true);
    expect(out.at(-1)).toMatchObject({ type: "finish" });
  });

  it("keeps leading whitespace blocks eligible for recovery", async () => {
    const out = await run([
      ...textBlock('\n  {"name":"get_weather","arguments":{"city":"Seoul"}}\n'),
      finishPart,
    ]);

    expect(out.some((p) => p.type === "tool-call")).toBe(true);
  });

  it("keeps spaced Qwen function tags eligible for recovery", async () => {
    const out = await run([
      ...textBlock(
        '<function = "get_weather"><parameter=city>Seoul</parameter></function>'
      ),
      finishPart,
    ]);

    const toolCall = out.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
  });

  it("passes everything through when no tools are configured", async () => {
    const parts = [
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}'),
      finishPart,
    ];
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        streamOf(parts),
        createStreamJsonRecoveryTransform({ tools: [] })
      )
    );
    expect(out).toEqual(parts);
  });
});

describe("createStreamJsonRecoveryTransform fenced blocks", () => {
  const finish: LanguageModelV4StreamPart = {
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  };

  it("recovers a tool call from a fenced json block", async () => {
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        streamOf([
          { type: "text-start", id: "t1" },
          {
            type: "text-delta",
            id: "t1",
            delta:
              '```json\n{\n  "name": "get_weather",\n  "arguments": {"city": "Seoul"}\n}\n```',
          },
          { type: "text-end", id: "t1" },
          finish,
        ]),
        createStreamJsonRecoveryTransform({ tools })
      )
    );

    const toolCall = out.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.input)).toEqual({ city: "Seoul" });
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
  });

  it("flushes inline-code prose without holding it", async () => {
    const payload = "`ls -la` lists files.";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        streamOf([...textBlock(payload), finish]),
        createStreamJsonRecoveryTransform({ tools })
      )
    );

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe(payload);
  });
});

describe("createStreamJsonRecoveryTransform extended hold shapes", () => {
  const finish: LanguageModelV4StreamPart = {
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  };

  it("recovers an array-wrapped call list", async () => {
    const out = await run([
      ...textBlock(
        '[{"name":"get_weather","arguments":{"city":"Seoul"}}, {"name":"get_weather","arguments":{"city":"Tokyo"}}]'
      ),
      finish,
    ]);

    const calls = out.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
  });

  it("recovers a literal tool_call tag leaking through a foreign protocol", async () => {
    const out = await run([
      ...textBlock(
        '<tool_call>[{"name":"get_weather","arguments":{"city":"Seoul"}}]'
      ),
      finish,
    ]);

    const calls = out.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
  });

  it("flushes tag-like prose that is not a tool_call tag", async () => {
    const payload = "<toolbox> content here";
    const out = await run([...textBlock(payload), finish]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe(payload);
  });
});

describe("createStreamJsonRecoveryTransform per-block independence (review fixes)", () => {
  const finish: LanguageModelV4StreamPart = {
    type: "finish",
    finishReason: stopFinishReason,
    usage: zeroUsage,
  };

  it("recovers a second bare-JSON block after a successful recovery", async () => {
    const out = await run([
      ...textBlock('{"name":"get_weather","arguments":{"city":"Seoul"}}', "t1"),
      ...textBlock('{"name":"get_weather","arguments":{"city":"Tokyo"}}', "t2"),
      finish,
    ]);

    const calls = out.filter((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >[];
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => JSON.parse(c.input).city)).toEqual([
      "Seoul",
      "Tokyo",
    ]);
    expect(out.some((p) => p.type === "text-delta")).toBe(false);
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
      finish,
    ]);

    const calls = out.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(2);
  });

  it("streams non-recoverable fenced blocks through without holding", async () => {
    const transformer = createStreamJsonRecoveryTransform({ tools });
    const writer = transformer.writable.getWriter();
    const reader = transformer.readable.getReader();

    // No close(): parts must arrive while the block is still open.
    const writes = (async () => {
      await writer.write({ type: "text-start", id: "t1" });
      await writer.write({
        type: "text-delta",
        id: "t1",
        delta: "```python\nprint('hi')\n",
      });
    })();

    expect((await reader.read()).value).toMatchObject({ type: "text-start" });
    expect((await reader.read()).value).toMatchObject({
      type: "text-delta",
      delta: "```python\nprint('hi')\n",
    });

    await writes;
    await writer.close();
  });

  it("flushes bracketed prose that is not an array of calls", async () => {
    const payload = "[1] First citation in the list.";
    const out = await run([...textBlock(payload), finish]);

    expect(out.some((p) => p.type === "tool-call")).toBe(false);
    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe(payload);
  });
});
