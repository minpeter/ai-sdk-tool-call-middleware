import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import {
  requireToolCall,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type HermesError = NonNullable<ParserOptions["onError"]>;

function patternTool(pattern: string): LanguageModelV4FunctionTool {
  const inputSchema: JSONSchema7 = {
    type: "object",
    properties: { content: { type: "string" } },
    patternProperties: { [pattern]: false },
    additionalProperties: true,
  };
  return { type: "function", name: "write", inputSchema };
}

function repairPattern(
  pattern: string,
  blockedProperty: string,
  onError: HermesError
): Promise<LanguageModelV4StreamPart[]> {
  const argumentsValue = { content: "ok", [blockedProperty]: "blocked" };
  return runProtocolTextStream({
    chunks: [
      `<tool_call>${JSON.stringify({ name: "write", arguments: argumentsValue })}</tool_call>`,
    ],
    id: "1",
    parserOptions: { onError },
    protocol: hermesProtocol(),
    tools: [patternTool(pattern)],
  });
}

function expectBlockedKeyRemoved(
  output: LanguageModelV4StreamPart[],
  onError: HermesError
): void {
  const tool = output.find((part) => part.type === "tool-call");
  expect(tool).toBeTruthy();
  expect(JSON.parse(requireToolCall(output).input)).toEqual({ content: "ok" });
  const timeline = selectToolInputTimeline(output);
  expect(timeline.starts.length > 0).toBe(true);
  expect(timeline.deltas.length > 0).toBe(true);
  expect(timeline.ends.length > 0).toBe(true);
  expect(onError).not.toHaveBeenCalled();
}

describe("json-repair.test split 13", () => {
  it("drops unsafe false patternProperties that may match key substrings", async () => {
    const onError = vi.fn<HermesError>();
    const out = await repairPattern("(secret+)+", "x-secret", onError);

    expectBlockedKeyRemoved(out, onError);
  });

  it("drops unsafe false patternProperties that may match unanchored suffixes", async () => {
    const onError = vi.fn<HermesError>();
    const out = await repairPattern("(a+)+$", "ba", onError);

    expectBlockedKeyRemoved(out, onError);
  });

  it("does not emit stale speculative tool-calls after later invalid chunks", async () => {
    const onError = vi.fn<HermesError>();
    const transformer = hermesProtocol().createStreamParser({
      tools: [],
      options: { onError },
    });
    const input = new TransformStream<
      LanguageModelV4StreamPart,
      LanguageModelV4StreamPart
    >();
    const out: LanguageModelV4StreamPart[] = [];
    let resolveInputStart!: () => void;
    const inputStartObserved = new Promise<void>((resolve) => {
      resolveInputStart = resolve;
    });
    const done = input.readable.pipeThrough(transformer).pipeTo(
      new WritableStream<LanguageModelV4StreamPart>({
        write(part) {
          out.push(part);
          if (part.type === "tool-input-start") {
            resolveInputStart();
          }
        },
      })
    );
    const writer = input.writable.getWriter();

    await writer.write({
      type: "text-delta",
      id: "1",
      delta: '<tool_call>{"name":"edit","arguments":{"content":"ok"}}',
    });
    await inputStartObserved;
    await writer.write({
      type: "text-delta",
      id: "1",
      delta: ',"dangling":</tool_call>',
    });
    await writer.write({
      type: "finish",
      finishReason: stopFinishReason,
      usage: zeroUsage,
    });
    await writer.close();
    await done;

    const start = out.find((part) => part.type === "tool-input-start");
    expect(out.find((part) => part.type === "tool-call")).toBeUndefined();
    expect(start).toBeTruthy();
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(true);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(true);
    expect(onError).toHaveBeenCalled();
    const metadata = onError.mock.calls[0]?.[1];
    expect(typeof metadata?.toolCallId).toBe("string");
    if (typeof metadata?.toolCallId !== "string") {
      throw new Error("Expected onError metadata with a toolCallId");
    }
    expect(metadata.toolCallId).toBe(
      start?.type === "tool-input-start" ? start.id : undefined
    );
  });

  it("drops keys that may match unsafe false patterns with escaped range endpoints", async () => {
    const onError = vi.fn<HermesError>();
    const out = await repairPattern("^([a-\\x7a]+)+$", "m", onError);

    expectBlockedKeyRemoved(out, onError);
  });
});
