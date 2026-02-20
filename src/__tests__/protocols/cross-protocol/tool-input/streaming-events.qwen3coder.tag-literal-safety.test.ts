import { describe, expect, it } from "vitest";

import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { runProtocolTextDeltaStream } from "./streaming-events.shared";

describe("cross-protocol tool-input streaming events: qwen3coder", () => {
  const protocol = qwen3CoderProtocol();

  function runQwenTagSafetyStream(chunks: string[]) {
    return runProtocolTextDeltaStream({ protocol, tools: [], chunks });
  }

  it("Qwen3CoderToolParser does not truncate parameter values containing </toolbox> pseudo-tags", async () => {
    const out = await runQwenTagSafetyStream([
      "<tool_call><function=alpha><parameter=query>How to close </toolbox> tag</function></tool_call>",
    ]);

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
    const out = await runQwenTagSafetyStream([
      "<tool_call><function=alpha><parameter=query>How to use </tool> tag</function></tool_call>",
    ]);

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
    const out = await runQwenTagSafetyStream([
      "<tool_call><call=alpha><parameter=query>How to use </call",
      "out> tag</call></tool_call>",
    ]);

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
    const input = "before <function>docs</function> after";
    const out = await runQwenTagSafetyStream([
      "before <function>docs",
      "</function> after",
    ]);

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
