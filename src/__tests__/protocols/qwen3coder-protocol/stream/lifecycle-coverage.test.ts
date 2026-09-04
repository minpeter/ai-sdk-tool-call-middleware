import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import {
  collectProtocolStream,
  collectTextDeltas,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
    },
  },
  {
    type: "function",
    name: "write_file",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
    },
  },
];

const finishPart = {
  type: "finish",
  finishReason: stopFinishReason,
  usage: zeroUsage,
} satisfies LanguageModelV4StreamPart;

function parseParts(
  parts: readonly LanguageModelV4StreamPart[],
  parserOptions?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return collectProtocolStream({
    parts,
    protocol: qwen3CoderProtocol(),
    tools,
    parserOptions,
  });
}

const textOf = collectTextDeltas;
const callsOf = selectToolCalls;

describe("qwen3CoderProtocol stream parser lifecycle coverage", () => {
  it("preserves raw and non-text events while dropping provider text envelopes", async () => {
    // Given
    const raw = { type: "raw", rawValue: { sequence: 1 } } as const;
    const reasoning = { type: "reasoning-start", id: "reasoning-1" } as const;

    // When
    const output = await parseParts([
      { type: "text-start", id: "provider-text" },
      { type: "text-delta", id: "provider-text", delta: "<tool_ca" },
      raw,
      reasoning,
      { type: "text-delta", id: "provider-text", delta: "" },
      { type: "text-end", id: "provider-text" },
      finishPart,
    ]);

    // Then
    expect(output).toContainEqual(raw);
    expect(output).toContainEqual(reasoning);
    expect(output.findIndex((part) => part.type === "raw")).toBeLessThan(
      output.findIndex((part) => part.type === "text-delta")
    );
    expect(textOf(output)).toBe("<tool_ca");
    expect(output.at(-1)).toEqual(finishPart);
  });

  it("emits the complete lifecycle for a salvaged JSON call", async () => {
    const input =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Seoul"}}';

    const output = await parseParts([
      { type: "text-delta", id: "1", delta: input },
      finishPart,
    ]);
    const [call] = callsOf(output);
    if (call === undefined) {
      throw new TypeError("Expected a salvaged tool call");
    }
    const timeline = selectToolInputTimeline(output);

    expect(timeline.starts).toEqual([
      {
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: "get_weather",
      },
    ]);
    expect(timeline.deltas).toEqual([
      {
        type: "tool-input-delta",
        id: call.toolCallId,
        delta: '{"city":"Seoul"}',
      },
    ]);
    expect(timeline.ends).toEqual([
      { type: "tool-input-end", id: call.toolCallId },
    ]);
    expect(output.at(-1)).toEqual(finishPart);
  });

  it("emits a self-closing implicit call and preserves its trailing text", async () => {
    // Given
    const input = "<function=get_weather/> after";

    // When
    const output = await parseParts([
      { type: "text-delta", id: "1", delta: input },
      finishPart,
    ]);

    // Then
    expect(callsOf(output)).toMatchObject([
      { toolName: "get_weather", input: "{}" },
    ]);
    expect(textOf(output)).toBe(" after");
  });

  it("chains an implicit call into an explicit container in one chunk", async () => {
    // Given
    const input =
      "<function=get_weather><parameter=city>Seoul</parameter></function>" +
      "</tool_call><tool_call><function=get_weather>" +
      "<parameter=city>Busan</parameter></function></tool_call>";

    // When
    const output = await parseParts([
      { type: "text-delta", id: "1", delta: input },
      finishPart,
    ]);

    // Then
    expect(callsOf(output).map((call) => JSON.parse(call.input))).toEqual([
      { city: "Seoul" },
      { city: "Busan" },
    ]);
    expect(textOf(output)).toBe("");
  });

  it("falls back to text for a malformed explicit opening tag", async () => {
    // Given
    const malformed = "<tool_calling>visible";

    // When
    const output = await parseParts([
      { type: "text-delta", id: "1", delta: malformed },
      finishPart,
    ]);

    // Then
    expect(callsOf(output)).toHaveLength(0);
    expect(textOf(output)).toBe(malformed);
  });

  it("reports an unfinished implicit call without leaking raw markup", async () => {
    // Given
    const onError = vi.fn();

    // When
    const output = await parseParts(
      [
        {
          type: "text-delta",
          id: "1",
          delta:
            '<function=get_weather><parameter=constructor>{"polluted":true}',
        },
        finishPart,
      ],
      { onError }
    );

    // Then
    expect(callsOf(output)).toHaveLength(0);
    expect(textOf(output)).toBe("");
    expect(onError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        toolName: "get_weather",
        dropReason: "unfinished-tool-call",
      })
    );
  });

  it("preserves text after an implicit call completed by a later chunk", async () => {
    // Given
    const opening = "<function=get_weather><parameter=city>Seoul</parameter>";

    // When
    const output = await parseParts([
      { type: "text-delta", id: "1", delta: opening },
      {
        type: "text-delta",
        id: "1",
        delta: "</function> after",
      },
      finishPart,
    ]);

    // Then
    expect(callsOf(output)).toMatchObject([
      { toolName: "get_weather", input: '{"city":"Seoul"}' },
    ]);
    expect(textOf(output)).toBe(" after");
  });

  it("normalizes an unfinished partial nested call before reporting it", async () => {
    // Given
    const onError = vi.fn();

    // When
    const output = await parseParts(
      [
        { type: "text-delta", id: "1", delta: "<tool_call><function" },
        finishPart,
      ],
      { onError }
    );

    // Then
    expect(callsOf(output)).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dropReason: "unfinished-tool-call" })
    );
  });

  for (const scenario of [
    {
      name: "finishes a deferred explicit call while handling finish",
      prefix: "<tool_call>",
      suffix: "</tool_call>",
    },
    {
      name: "finishes a deferred implicit call without trailing remainder",
      prefix: "",
      suffix: "",
    },
  ] satisfies readonly { name: string; prefix: string; suffix: string }[]) {
    it(scenario.name, async () => {
      const { prefix, suffix } = scenario;
      // Given
      const content = "x".repeat(5000);

      // When
      const output = await parseParts([
        {
          type: "text-delta",
          id: "1",
          delta: `${prefix}<function=write_file><parameter=content>${content}`,
        },
        {
          type: "text-delta",
          id: "1",
          delta: `</parameter>< / function >${suffix}`,
        },
        finishPart,
      ]);

      // Then
      expect(callsOf(output)).toHaveLength(1);
      expect(JSON.parse(callsOf(output)[0]?.input ?? "{}")).toEqual({
        content,
      });
    });
  }

  it("finishes deferred implicit and explicit calls at the finish boundary", async () => {
    // Given
    const content = "x".repeat(5000);
    const implicitPrefix = `<function=write_file><parameter=content>${content}`;
    const explicitCall =
      "<tool_call><function=get_weather><parameter=city>Busan</parameter>" +
      "< / function ></tool_call>";

    // When
    const output = await parseParts([
      { type: "text-delta", id: "1", delta: implicitPrefix },
      {
        type: "text-delta",
        id: "1",
        delta: `</parameter>< / function >${explicitCall}`,
      },
      finishPart,
    ]);

    // Then
    expect(callsOf(output).map((call) => call.toolName)).toEqual([
      "write_file",
      "get_weather",
    ]);
    expect(JSON.parse(callsOf(output)[0]?.input ?? "{}")).toEqual({ content });
  });
});
