import { describe, expect, it } from "vitest";
import { createOpenAIStreamConverter } from "./response-converter.js";

function parse(data: string) {
  return JSON.parse(data) as {
    choices: Array<{ delta?: any; finish_reason?: string }>;
  };
}

describe("createOpenAIStreamConverter - finish_reason semantics", () => {
  it("emits tool_calls as finish_reason when a tool-call occurred before finish-step", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks1 = convert({ type: "start" });
    const chunks2 = convert({
      type: "tool-call",
      toolCallId: "1",
      toolName: "x",
      input: {},
    });
    const chunks3 = convert({ type: "finish-step", finishReason: "stop" });
    const chunks4 = convert({ type: "finish", finishReason: "stop" });

    const all = [...chunks1, ...chunks2, ...chunks3, ...chunks4].map((c) =>
      parse(c.data)
    );
    const reasons = all
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));

    expect(reasons).toEqual(["tool_calls"]);
  });

  it("emits stop when no tool calls occurred", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks1 = convert({ type: "start" });
    const chunks2 = convert({ type: "text-delta", text: "hi" });
    const chunks3 = convert({ type: "finish-step", finishReason: "stop" });

    const all = [...chunks1, ...chunks2, ...chunks3].map((c) => parse(c.data));
    const reasons = all
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));

    expect(reasons).toEqual(["stop"]);
  });

  it("does not duplicate finish when both finish-step and finish arrive", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks1 = convert({ type: "start" });
    const chunks2 = convert({
      type: "tool-call-delta",
      toolName: "x",
      args: '{"a":1}',
    });
    const chunks3 = convert({ type: "finish-step", finishReason: "stop" });
    const chunks4 = convert({ type: "finish", finishReason: "stop" });

    const all = [...chunks1, ...chunks2, ...chunks3, ...chunks4].map((c) =>
      parse(c.data)
    );
    const reasons = all
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));

    expect(reasons).toEqual(["tool_calls"]);
  });

  it("handles finish chunk without prior finish-step", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks = [
      ...convert({ type: "start" }),
      ...convert({ type: "finish", finishReason: "stop" }),
    ];

    const parsed = chunks.map((c) => parse(c.data));
    const reasons = parsed
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));

    expect(reasons).toEqual(["stop"]);
  });

  it("handles finish-step chunk when no finish follows", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks = [
      ...convert({ type: "start" }),
      ...convert({ type: "finish-step", finishReason: "stop" }),
    ];

    const parsed = chunks.map((c) => parse(c.data));
    const reasons = parsed
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));

    expect(reasons).toEqual(["stop"]);
  });

  it("supports multiple tool-call deltas with distinct indexes", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");

    const chunks = [
      ...convert({ type: "start" }),
      ...convert({
        type: "tool-call-delta",
        toolCallId: "0",
        toolName: "alpha",
        args: '{"value":1}',
      }),
      ...convert({
        type: "tool-call-delta",
        toolCallId: "1",
        toolName: "beta",
        args: '{"value":2}',
      }),
      ...convert({ type: "finish-step", finishReason: "tool_calls" }),
    ];

    const parsed = chunks.map((c) => parse(c.data));
    const toolCallArrays = parsed
      .map(
        (p) => (p.choices?.[0]?.delta as any)?.tool_calls as any[] | undefined
      )
      .filter((calls): calls is any[] => Array.isArray(calls));
    const allToolCalls = toolCallArrays.flat();

    expect(allToolCalls.map((tc) => tc.index)).toEqual([0, 1]);
    expect(allToolCalls.map((tc) => tc.function?.name)).toEqual([
      "alpha",
      "beta",
    ]);

    const reasons = parsed
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));
    expect(reasons).toEqual(["tool_calls"]);
  });
});
