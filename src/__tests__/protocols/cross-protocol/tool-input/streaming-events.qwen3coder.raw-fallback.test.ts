import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { pipeWithTransformer } from "../../../test-helpers";
import { createTextDeltaStream } from "./streaming-events.qwen3coder.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  it("Qwen3CoderToolParser preserves trailing plain text when finish-time malformed tool_call parse fails", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER",
        ]),
        transformer
      )
    );

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
    const protocol = qwen3CoderProtocol();
    const input =
      "<tool_call><function><parameter=x>1</parameter></tool_call>AFTER";
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(createTextDeltaStream([input]), transformer)
    );

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
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<tool_call><function=get_weather"]),
        transformer
      )
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
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "before ",
          "<tool_call><parameter=x>1</parameter></tool_call>",
          " after",
        ]),
        transformer
      )
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
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<function><parameter=x>1</parameter>"]),
        transformer
      )
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
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<tool_call><function=get_weather"]),
        transformer
      )
    );

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(leakedText).not.toContain("<tool_call");
  });
});
