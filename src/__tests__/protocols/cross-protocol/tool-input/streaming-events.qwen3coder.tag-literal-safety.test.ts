import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { pipeWithTransformer } from "../../../test-helpers";
import { createTextDeltaStream } from "./streaming-events.qwen3coder.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  it("Qwen3CoderToolParser does not truncate parameter values containing </toolbox> pseudo-tags", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=query>How to close </toolbox> tag</function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      query: "How to close </toolbox> tag",
    });
  });

  it("Qwen3CoderToolParser keeps </tool> text when parsing a <function> call", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=query>How to use </tool> tag</function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      query: "How to use </tool> tag",
    });
  });

  it("Qwen3CoderToolParser does not treat chunk-terminal </call prefix as a completed boundary", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><call=alpha><parameter=query>How to use </call",
          "out> tag</call></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      query: "How to use </callout> tag",
    });
  });

  it("Qwen3CoderToolParser keeps implicit-call-like tags without tool identifier as text", async () => {
    const protocol = qwen3CoderProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const input = "before <function>docs</function> after";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["before <function>docs", "</function> after"]),
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
    expect(textOut).toBe(input);
  });
});
