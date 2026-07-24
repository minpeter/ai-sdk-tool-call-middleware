import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import type { ParserOptions } from "../../../core/protocols/protocol-interface";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  assertCanonicalAiSdkEventOrder,
  assertCoreAiSdkEventCoverage,
  extractTextDeltas,
  extractToolInputDeltas,
  extractToolInputTimeline,
  findToolCall,
  runProtocolTextDeltaStream,
} from "../cross-protocol/tool-input/streaming-events.shared";
import {
  glm5Tools,
  normalizeContentToolCalls,
  normalizeStreamToolCalls,
} from "./shared";

const CANONICAL_CALL = [
  "<tool_call>typed_action",
  "<arg_key>text</arg_key><arg_value>hello 🚀</arg_value>",
  "<arg_key>count</arg_key><arg_value>7</arg_value>",
  "<arg_key>enabled</arg_key><arg_value>true</arg_value>",
  '<arg_key>tags</arg_key><arg_value>["a","b"]</arg_value>',
  "</tool_call>",
].join("");

interface StreamHarness {
  finish: () => Promise<LanguageModelV4StreamPart[]>;
  parts: LanguageModelV4StreamPart[];
  writeText: (delta: string) => Promise<void>;
}

function createStreamHarness(options?: ParserOptions): StreamHarness {
  const transformer = glm5Protocol().createStreamParser({
    tools: glm5Tools,
    options,
  });
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const parts: LanguageModelV4StreamPart[] = [];
  const collect = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      parts.push(result.value);
    }
  })();

  return {
    parts,
    async writeText(delta) {
      await writer.write({ type: "text-delta", id: "fixture", delta });
    },
    async finish() {
      await writer.write({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      await writer.close();
      await collect;
      return parts;
    },
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd8_00 && code <= 0xdb_ff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc_00 && next <= 0xdf_ff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc_00 && code <= 0xdf_ff) {
      return true;
    }
  }
  return false;
}

function assertBalancedToolInputLifecycle(
  parts: LanguageModelV4StreamPart[]
): void {
  const timeline = extractToolInputTimeline(parts);
  expect(timeline.starts.length).toBe(timeline.ends.length);
  for (const start of timeline.starts) {
    expect(timeline.ends.filter((end) => end.id === start.id)).toHaveLength(1);
  }
  for (const call of parts.filter((part) => part.type === "tool-call")) {
    expect(timeline.starts.some((start) => start.id === call.toolCallId)).toBe(
      true
    );
    expect(timeline.ends.some((end) => end.id === call.toolCallId)).toBe(true);
    expect(
      timeline.deltas
        .filter((delta) => delta.id === call.toolCallId)
        .map((delta) => delta.delta)
        .join("")
    ).toBe(call.input);
  }
}

describe("glm5Protocol streaming lifecycle", () => {
  it("keeps generated-name recovery invariant under single-character chunks", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "OnlineShopping_searchExpress_a9bee1c127af",
        inputSchema: {
          type: "object",
          properties: { express_id: { type: "string" } },
          required: ["express_id"],
        },
      },
      {
        type: "function",
        name: "NewsMagazines_viewCollection_932c48ae403c",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    ];
    const text = [
      "<tool_call>OnlineShopping_searchExpress_a9bee1c127afaf",
      "<arg_key>express_id</arg_key><arg_value>123</arg_value>",
      "</tool_call>",
      "<tool_call>NewsMagazines_viewCollect_932c48ae403c",
      "</arg_value></tool_call>",
    ].join("");
    const onError = vi.fn();
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools,
      chunks: text.split(""),
      options: { onError },
    });

    expect(normalizeStreamToolCalls(output)).toEqual([
      {
        toolName: "OnlineShopping_searchExpress_a9bee1c127af",
        input: { express_id: "123" },
      },
      {
        toolName: "NewsMagazines_viewCollection_932c48ae403c",
        input: {},
      },
    ]);
    assertCanonicalAiSdkEventOrder(output);
    assertBalancedToolInputLifecycle(output);
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed streaming GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining(["recovered-tool-name"]),
      })
    );
  });

  it("emits canonical text and tool-input lifecycles around a GLM call", async () => {
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: ["before ", CANONICAL_CALL, " after"],
    });

    assertCanonicalAiSdkEventOrder(output);
    assertCoreAiSdkEventCoverage(output);
    expect(extractTextDeltas(output)).toBe("before  after");

    const call = findToolCall(output);
    const timeline = extractToolInputTimeline(output);
    expect(timeline.starts).toEqual([
      {
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: "typed_action",
      },
    ]);
    expect(timeline.ends).toEqual([
      { type: "tool-input-end", id: call.toolCallId },
    ]);
    expect(extractToolInputDeltas(output).join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual({
      text: "hello 🚀",
      count: 7,
      enabled: true,
      tags: ["a", "b"],
    });
  });

  it("is invariant across every two-chunk boundary and all single-code-unit chunks", async () => {
    const expected = [
      {
        toolName: "typed_action",
        input: {
          text: "hello 🚀",
          count: 7,
          enabled: true,
          tags: ["a", "b"],
        },
      },
    ];

    for (let split = 1; split < CANONICAL_CALL.length; split += 1) {
      const output = await runProtocolTextDeltaStream({
        protocol: glm5Protocol(),
        tools: glm5Tools,
        chunks: [CANONICAL_CALL.slice(0, split), CANONICAL_CALL.slice(split)],
      });
      expect(normalizeStreamToolCalls(output), `split=${split}`).toEqual(
        expected
      );
      const call = findToolCall(output);
      expect(extractToolInputDeltas(output).join(""), `split=${split}`).toBe(
        call.input
      );
      expect(extractTextDeltas(output), `split=${split}`).toBe("");
      assertCanonicalAiSdkEventOrder(output);
    }

    const characterChunked = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: CANONICAL_CALL.split(""),
    });
    expect(normalizeStreamToolCalls(characterChunked)).toEqual(expected);
    expect(extractToolInputDeltas(characterChunked).join("")).toBe(
      findToolCall(characterChunked).input
    );
  });

  it("keeps opaque object-reference recovery invariant under one-character chunks", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "consume",
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
          required: ["payload"],
        },
      },
    ];
    const text =
      "<tool_call>consume<arg_key>payload</arg_key><arg_value>responseData</arg_value></tool_call>";
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([
      { toolName: "consume", input: { payload: "responseData" } },
    ]);
    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("keeps Markdown code examples non-executable under one-character chunks", async () => {
    const text = "Example only, do not execute: `<tool_call>ping</tool_call>`.";
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([]);
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(extractTextDeltas(streamed)).toBe(text);
    assertBalancedToolInputLifecycle(streamed);
  });

  it("keeps calls after balanced code spans executable under one-character chunks", async () => {
    const text = [
      "Use `CellResult`",
      "<tool_call>ping</tool_call>",
      "<tool_call>ping</tool_call>",
    ].join("");
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([
      { toolName: "ping", input: {} },
      { toolName: "ping", input: {} },
    ]);
    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    expect(extractTextDeltas(streamed)).toBe("Use `CellResult`");
    assertBalancedToolInputLifecycle(streamed);
  });

  it("keeps a canonical call after malformed prose backticks chunk-invariant", async () => {
    const text =
      "Repository `https://example.test/repo%60 from `/home/user` right away.<tool_call>ping</tool_call>";
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([
      { toolName: "ping", input: {} },
    ]);
    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("rejects a nested complete call naming a declared tool in generate and stream", async () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>outer <tool_call>ping</tool_call></arg_value></tool_call>";
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([]);
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    assertBalancedToolInputLifecycle(streamed);
  });

  it.each(["< tool_call >", "<tool_call >", "< TOOL_CALL >"])(
    "recognizes the tolerated open tag %s across every chunk boundary",
    async (openTag) => {
      const text = `${openTag}echo<arg_key>message</arg_key><arg_value>split safe</arg_value></tool_call>`;
      const expected = [{ toolName: "echo", input: { message: "split safe" } }];

      for (let split = 1; split < openTag.length; split += 1) {
        const output = await runProtocolTextDeltaStream({
          protocol: glm5Protocol(),
          tools: glm5Tools,
          chunks: [text.slice(0, split), text.slice(split)],
        });
        expect(normalizeStreamToolCalls(output), `split=${split}`).toEqual(
          expected
        );
        expect(extractTextDeltas(output), `split=${split}`).toBe("");
      }

      const characterChunked = await runProtocolTextDeltaStream({
        protocol: glm5Protocol(),
        tools: glm5Tools,
        chunks: text.split(""),
      });
      expect(normalizeStreamToolCalls(characterChunked)).toEqual(expected);
      expect(extractTextDeltas(characterChunked)).toBe("");
      assertCanonicalAiSdkEventOrder(characterChunked);
    }
  );

  it("does not expose an unpaired UTF-16 surrogate when a chunk splits an emoji", async () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>go 🚀 now</arg_value></tool_call>";
    const emojiIndex = text.indexOf("🚀");
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [text.slice(0, emojiIndex + 1), text.slice(emojiIndex + 1)],
    });
    const call = findToolCall(output);
    const deltas = extractToolInputDeltas(output);

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((delta) => !hasUnpairedSurrogate(delta))).toBe(true);
    expect(deltas.join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual({ message: "go 🚀 now" });
  });

  it("emits a long string argument incrementally before the closing tags arrive", async () => {
    const harness = createStreamHarness();
    const longValue = `begin-${"x".repeat(4096)}-end`;
    await harness.writeText(
      `<tool_call>echo<arg_key>message</arg_key><arg_value>${longValue}`
    );

    await vi.waitFor(() => {
      expect(
        extractToolInputDeltas(harness.parts).join("").length
      ).toBeGreaterThan(4000);
    });
    expect(harness.parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(extractToolInputDeltas(harness.parts).join("")).toContain(
      longValue.slice(0, 2048)
    );

    await harness.writeText("</arg_value></tool_call>");
    const output = await harness.finish();
    const call = findToolCall(output);
    expect(extractToolInputDeltas(output).join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual({ message: longValue });
  });

  it("processes a 20k single-character long-string stream within the linear-time budget", async () => {
    const longValue = "x".repeat(20_000);
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${longValue}</arg_value></tool_call>`;
    const startedAt = performance.now();
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: text.split(""),
    });
    const elapsedMs = performance.now() - startedAt;
    const call = findToolCall(output);

    expect(JSON.parse(call.input)).toEqual({ message: longValue });
    expect(extractToolInputDeltas(output).join("")).toBe(call.input);
    expect(elapsedMs).toBeLessThan(2000);
  }, 10_000);

  it("buffers array and object values until each complete value can be schema-coerced", async () => {
    const harness = createStreamHarness();
    await harness.writeText(
      "<tool_call>aggregate<arg_key>items</arg_key><arg_value>[1,2"
    );
    await vi.waitFor(() => {
      expect(
        harness.parts.some((part) => part.type === "tool-input-start")
      ).toBe(true);
    });
    const beforeArrayClose = extractToolInputDeltas(harness.parts).join("");
    expect(beforeArrayClose).not.toContain("items");
    expect(beforeArrayClose).not.toContain("[1,2");

    await harness.writeText(
      ',3]</arg_value><arg_key>config</arg_key><arg_value>{"mode":"safe"'
    );
    await vi.waitFor(() => {
      expect(extractToolInputDeltas(harness.parts).join("")).toContain(
        '"items":[1,2,3'
      );
    });
    const beforeObjectClose = extractToolInputDeltas(harness.parts).join("");
    expect(beforeObjectClose).not.toContain("config");
    expect(beforeObjectClose).not.toContain("mode");

    await harness.writeText(',"enabled":true}</arg_value></tool_call>');
    const output = await harness.finish();
    const call = findToolCall(output);
    expect(extractToolInputDeltas(output).join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual({
      items: [1, 2, 3],
      config: { mode: "safe", enabled: true },
    });
  });

  it("recovers an unfinished final call when the finish event arrives", async () => {
    const onError = vi.fn();
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [
        "<tool_call>echo<arg_key>message</arg_key><arg_value>still useful",
      ],
      options: { onError },
    });

    assertCanonicalAiSdkEventOrder(output);
    expect(normalizeStreamToolCalls(output)).toEqual([
      { toolName: "echo", input: { message: "still useful" } },
    ]);
    expect(extractToolInputDeltas(output).join("")).toBe(
      findToolCall(output).input
    );
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed streaming GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-missing-arg-value-close",
          "recovered-missing-tool-call-close",
        ]),
      })
    );
  });

  it.each([
    "before <tool_call> literal after",
    "before < tool_call > literal after",
    "before <tool_call>x</tool_call> literal after",
  ])(
    "preserves tool-call-like markup inside a schema string: %s",
    async (message) => {
      const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
      const output = await runProtocolTextDeltaStream({
        protocol: glm5Protocol(),
        tools: glm5Tools,
        chunks: text.split(""),
      });
      const call = findToolCall(output);

      expect(JSON.parse(call.input)).toEqual({ message });
      expect(extractToolInputDeltas(output).join("")).toBe(call.input);
      expect(extractTextDeltas(output)).toBe("");
      assertCanonicalAiSdkEventOrder(output);
    }
  );

  it("defers a split outer close while recovering a missing argument close", async () => {
    const onError = vi.fn();
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [
        "<tool_call>echo<arg_key>message</arg_key><arg_value>ok",
        "</tool_call ",
        ">",
      ],
      options: { onError },
    });
    const call = findToolCall(output);
    const timeline = extractToolInputTimeline(output);

    expect(JSON.parse(call.input)).toEqual({ message: "ok" });
    expect(extractToolInputDeltas(output).join("")).toBe(call.input);
    expect(timeline.starts).toHaveLength(1);
    expect(timeline.ends).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed streaming GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-missing-arg-value-close",
        ]),
      })
    );
  });

  it("fails closed when missing structural closes contain a nested call", async () => {
    const onError = vi.fn();
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [
        "<tool_call>echo<arg_key>message</arg_key><arg_value>safe",
        "<tool_call>ping</tool_call>",
      ],
      options: { onError },
    });
    const timeline = extractToolInputTimeline(output);

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(timeline.starts.length).toBe(timeline.ends.length);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse streaming GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it("balances a started lifecycle when incomplete recovery is disabled", async () => {
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol({ recoverIncompleteToolCalls: false }),
      tools: glm5Tools,
      chunks: [
        "<tool_call>echo<arg_key>message</arg_key><arg_value>unfinished",
      ],
    });
    const timeline = extractToolInputTimeline(output);

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(timeline.starts).toHaveLength(1);
    expect(timeline.ends).toHaveLength(1);
  });

  it.each([
    [
      "duplicate argument",
      [
        "<tool_call>echo",
        "<arg_key>message</arg_key><arg_value>first</arg_value>",
        "<arg_key>message</arg_key><arg_value>second</arg_value>",
        "</tool_call>",
      ].join(""),
    ],
    [
      "prototype-sensitive value",
      [
        "<tool_call>typed_action<arg_key>config</arg_key>",
        '<arg_value>{"__proto__":{"polluted":true}}</arg_value>',
        "</tool_call>",
      ].join(""),
    ],
    [
      "prototype-sensitive key hidden by a closed schema",
      "<tool_call>echo<arg_key>__proto__</arg_key><arg_value>{}</arg_value></tool_call>",
    ],
  ])(
    "balances any started lifecycle for a rejected %s",
    async (_name, text) => {
      const output = await runProtocolTextDeltaStream({
        protocol: glm5Protocol(),
        tools: glm5Tools,
        chunks: text.split(""),
      });
      const timeline = extractToolInputTimeline(output);

      expect(output.some((part) => part.type === "tool-call")).toBe(false);
      expect(timeline.starts.length).toBe(timeline.ends.length);
    }
  );

  it("contains depth-limit failures without leaving a dangling lifecycle", async () => {
    const onError = vi.fn();
    const nestedArray = `${"[".repeat(6000)}0${"]".repeat(6000)}`;
    const output = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [
        "<tool_call>aggregate<arg_key>items</arg_key><arg_value>[1]</arg_value>",
        `<arg_key>config</arg_key><arg_value>${nestedArray}</arg_value></tool_call>`,
      ],
      options: { onError },
    });
    const timeline = extractToolInputTimeline(output);

    expect(output.some((part) => part.type === "tool-call")).toBe(false);
    expect(timeline.starts.length).toBe(timeline.ends.length);
    expect(output.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalled();
  });

  it("keeps stream/non-stream parity across structural delimiter pairs", async () => {
    const tokens = [
      "plain",
      "<arg_key>",
      "</arg_key>",
      "<arg_value>",
      "</arg_value>",
      "<tool_call>",
      "</tool_call>",
      "<tool_call>x</tool_call>",
    ];
    const mismatches: unknown[] = [];

    for (const left of tokens) {
      for (const right of tokens) {
        const message = `before ${left} middle ${right} after`;
        const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
        const protocol = glm5Protocol();
        const generated = protocol.parseGeneratedText({
          text,
          tools: glm5Tools,
        });
        const streamed = await runProtocolTextDeltaStream({
          protocol,
          tools: glm5Tools,
          chunks: text.split(""),
        });
        const generatedSignature = {
          calls: normalizeContentToolCalls(generated),
          text: generated
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        };
        const streamedSignature = {
          calls: normalizeStreamToolCalls(streamed),
          text: extractTextDeltas(streamed),
        };
        if (
          JSON.stringify(streamedSignature) !==
          JSON.stringify(generatedSignature)
        ) {
          mismatches.push({ generatedSignature, message, streamedSignature });
        }
      }
    }

    expect(mismatches.slice(0, 12)).toEqual([]);
  });

  it.each([
    "before </tool_call> literal after",
    "before </arg_value> literal </tool_call> after",
    "before </arg_value></tool_call> literal after",
  ])(
    "matches non-stream close selection for raw marker mix: %s",
    async (message) => {
      const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
      const protocol = glm5Protocol();
      const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
      const streamed = await runProtocolTextDeltaStream({
        protocol,
        tools: glm5Tools,
        chunks: text.split(""),
      });

      expect(normalizeStreamToolCalls(streamed)).toEqual(
        normalizeContentToolCalls(generated)
      );
      assertBalancedToolInputLifecycle(streamed);
    }
  );

  it("enforces the bounded close-candidate policy", async () => {
    const message = "x</tool_call>".repeat(300);
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${message}</arg_value></tool_call>`;
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeContentToolCalls(generated)).toEqual([]);
    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    assertBalancedToolInputLifecycle(streamed);
  });

  it("resynchronizes after a structurally closed rejected call", async () => {
    const rejected = [
      "<tool_call>echo",
      "<arg_key>message</arg_key><arg_value>first</arg_value>",
      "<arg_key>message</arg_key><arg_value>second</arg_value>",
      "</tool_call>",
    ].join("");
    const text = `${rejected}<tool_call>ping</tool_call>`;
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual([
      { toolName: "ping", input: {} },
    ]);
    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("poisons a chunked stream after an oversized body", async () => {
    const onError = vi.fn();
    const text = `<tool_call>echo<arg_key>message</arg_key><arg_value>${"x".repeat(
      1_048_577
    )}</arg_value></tool_call><tool_call>ping</tool_call>`;
    const streamed = await runProtocolTextDeltaStream({
      protocol: glm5Protocol(),
      tools: glm5Tools,
      chunks: [text],
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(extractTextDeltas(streamed)).toBe("");
    expect(streamed.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse streaming GLM-5.2 tool call.",
      expect.objectContaining({
        bodyLengthLimit: 1_048_576,
        toolCall: "[oversized GLM-5.2 tool call omitted]",
      })
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("bounds a one-character overflow and discards every later call", async () => {
    const onError = vi.fn();
    const harness = createStreamHarness({
      emitRawToolCallTextOnError: true,
      onError,
    });
    const bodyPrefix = "echo<arg_key>message</arg_key><arg_value>";
    const bodyAtLimit = `${bodyPrefix}${"x".repeat(
      1_048_576 - bodyPrefix.length
    )}`;

    await harness.writeText(`<tool_call>${bodyAtLimit}`);
    await harness.writeText("x");
    await harness.writeText(
      "</arg_value></tool_call><tool_call>ping</tool_call>"
    );
    const streamed = await harness.finish();

    expect(normalizeStreamToolCalls(streamed)).toEqual([]);
    expect(extractTextDeltas(streamed)).toBe("");
    expect(streamed.at(-1)?.type).toBe("finish");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        bodyLengthLimit: 1_048_576,
        toolCall: "[oversized GLM-5.2 tool call omitted]",
      })
    );
    assertBalancedToolInputLifecycle(streamed);
  });

  it("keeps the first recovery candidate across multiple deferred closes", async () => {
    const text = [
      "<tool_call>echo<arg_key>message</arg_key><arg_value>first",
      "</tool_call> middle </tool_call> trailing",
    ].join("");
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    assertBalancedToolInputLifecycle(streamed);
  });
});

describe("glm5Protocol streaming/non-streaming equivalence", () => {
  it("recovers an anchored bare call like the generate path", async () => {
    const text = 'get-weather(city="Seoul")';
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
  });

  const cases = [
    {
      name: "canonical typed call",
      text: CANONICAL_CALL,
    },
    {
      name: "zero-argument call",
      text: "<tool_call>ping</tool_call>",
    },
    {
      name: "two adjacent calls",
      text: [
        "<tool_call>get-weather<arg_key>city</arg_key><arg_value>Seoul</arg_value></tool_call>",
        "<tool_call>ping</tool_call>",
      ].join(""),
    },
    {
      name: "recoverable names and structural closes",
      text: "<tool_call>GET_WEATHER<arg_key>CITY<arg_value>Daegu",
    },
    {
      name: "unknown argument drop",
      text: [
        "<tool_call>get-weather",
        "<arg_key>city</arg_key><arg_value>Busan</arg_value>",
        "<arg_key>unknown</arg_key><arg_value>drop</arg_value>",
        "</tool_call>",
      ].join(""),
    },
  ];

  it.each(cases)("produces identical final calls: $name", async ({ text }) => {
    const protocol = glm5Protocol();
    const generated = protocol.parseGeneratedText({ text, tools: glm5Tools });
    const streamed = await runProtocolTextDeltaStream({
      protocol,
      tools: glm5Tools,
      chunks: text.split(""),
    });

    expect(normalizeStreamToolCalls(streamed)).toEqual(
      normalizeContentToolCalls(generated)
    );
    for (const call of streamed.filter((part) => part.type === "tool-call")) {
      const deltas = streamed
        .filter(
          (
            part
          ): part is Extract<
            LanguageModelV4StreamPart,
            { type: "tool-input-delta" }
          > => part.type === "tool-input-delta" && part.id === call.toolCallId
        )
        .map((part) => part.delta)
        .join("");
      expect(deltas).toBe(call.input);
    }
  });
});
