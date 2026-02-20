import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { runProtocolTextDeltaStream } from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const protocol = qwen3CoderProtocol();

  function runQwenRawFallbackStream(
    chunks: string[],
    emitRawToolCallTextOnError = false
  ) {
    return runProtocolTextDeltaStream({
      protocol,
      tools: [],
      chunks,
      options: { emitRawToolCallTextOnError },
    });
  }

  it("Qwen3CoderToolParser preserves trailing plain text when finish-time malformed tool_call parse fails", async () => {
    const out = await runQwenRawFallbackStream([
      "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER",
    ]);

    const textOut = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
    expect(textOut).toContain("AFTER");
    expect(textOut).not.toContain("<tool_call>");
  });

  it("Qwen3CoderToolParser emits malformed finish-time tool_call raw fallback once without duplicating trailing text", async () => {
    const input =
      "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER";
    const out = await runQwenRawFallbackStream([input], true);

    const textOut = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
    expect(textOut).toBe(input);
  });

  it("Qwen3CoderToolParser flushes buffered partial tool_call at finish as text when enabled", async () => {
    const out = await runQwenRawFallbackStream(
      ["<tool_call><function=get_weather"],
      true
    );

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
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

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
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

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
    expect(leakedText).toContain("<function><parameter=x>1</parameter>");
  });

  it("Qwen3CoderToolParser suppresses buffered partial tool_call at finish by default", async () => {
    const out = await runQwenRawFallbackStream([
      "<tool_call><function=get_weather",
    ]);

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(leakedText).not.toContain("<tool_call");
  });
});
