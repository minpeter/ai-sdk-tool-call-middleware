import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

function expectNoToolEvents(parts: readonly LanguageModelV4StreamPart[]): void {
  const { starts, deltas, ends } = selectToolInputTimeline(parts);
  expect(selectToolCalls(parts)).toHaveLength(0);
  expect(starts).toHaveLength(0);
  expect(deltas).toHaveLength(0);
  expect(ends).toHaveLength(0);
}

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const protocol = qwen3CoderProtocol();

  function runQwenRawFallbackStream(
    chunks: string[],
    emitRawToolCallTextOnError = false
  ) {
    return runProtocolTextStream({
      chunks,
      id: "fixture",
      parserOptions: { emitRawToolCallTextOnError },
      protocol,
      tools: [],
    });
  }

  it("Qwen3CoderToolParser preserves trailing plain text when finish-time malformed tool_call parse fails", async () => {
    const out = await runQwenRawFallbackStream([
      "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER",
    ]);

    const textOut = collectTextDeltas(out);

    expectNoToolEvents(out);
    expect(textOut).toContain("AFTER");
    expect(textOut).not.toContain("<tool_call>");
  });

  it("Qwen3CoderToolParser emits malformed finish-time tool_call raw fallback once without duplicating trailing text", async () => {
    const input =
      "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER";
    const out = await runQwenRawFallbackStream([input], true);

    const textOut = collectTextDeltas(out);

    expectNoToolEvents(out);
    expect(textOut).toBe(input);
  });

  it("Qwen3CoderToolParser flushes buffered partial tool_call at finish as text when enabled", async () => {
    const out = await runQwenRawFallbackStream(
      ["<tool_call><function=get_weather"],
      true
    );

    const leakedText = collectTextDeltas(out);

    expectNoToolEvents(out);
    expect(leakedText).toContain("<tool_call");
    expect(leakedText).toContain("<function=get_weather");
  });

  it("Qwen3CoderToolParser emits raw malformed tool_call text when tool name is missing and raw fallback is enabled", async () => {
    const out = await runQwenRawFallbackStream(
      [
        "before ",
        "<tool_call><parameter=x>1</parameter></tool_call>",
        " after",
      ],
      true
    );

    const leakedText = collectTextDeltas(out);

    expectNoToolEvents(out);
    expect(leakedText).toContain("before ");
    expect(leakedText).toContain(
      "<tool_call><parameter=x>1</parameter></tool_call>"
    );
    expect(leakedText).toContain(" after");
  });

  it("Qwen3CoderToolParser emits full raw malformed implicit-call text at finish when raw fallback is enabled", async () => {
    const out = await runQwenRawFallbackStream(
      ["<function><parameter=x>1</parameter>"],
      true
    );

    const leakedText = collectTextDeltas(out);

    expectNoToolEvents(out);
    expect(leakedText).toContain("<function><parameter=x>1</parameter>");
  });

  it("Qwen3CoderToolParser reports structured drop metadata for unfinished named tool_call at finish", async () => {
    const onError = vi.fn();
    await runProtocolTextStream({
      chunks: ["<tool_call><function=get_weather"],
      id: "fixture",
      parserOptions: { onError },
      protocol,
      tools: [],
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "unfinished-tool-call",
    });
    expect(metadata.toolCallId).toBeUndefined();
    expect(metadata.toolCall).toContain("<tool_call");
    expect(metadata.toolCall).toContain("<function=get_weather");
  });

  it("Qwen3CoderToolParser suppresses buffered partial tool_call at finish by default", async () => {
    const out = await runQwenRawFallbackStream([
      "<tool_call><function=get_weather",
    ]);

    const leakedText = collectTextDeltas(out);

    expect(selectToolCalls(out)).toHaveLength(0);
    expect(leakedText).not.toContain("<tool_call");
  });
});
