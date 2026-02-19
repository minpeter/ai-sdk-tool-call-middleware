import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";

describe("qwen3CoderProtocol", () => {
  it("parseGeneratedText extracts <tool_call> blocks and preserves surrounding text", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "before ",
      `<tool_call>
  <function=search>
    <parameter=query>
      AI
    </parameter>
    <parameter=query> ML </parameter>
    <parameter=lang> en </parameter>
  </function>
</tool_call>`,
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });

    const toolCall = out[1];
    if (toolCall.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(toolCall.type).toBe("tool-call");
    expect(toolCall.toolName).toBe("search");
    expect(JSON.parse(toolCall.input)).toEqual({
      query: ["AI", "ML"],
      lang: "en",
    });
  });

  it("supports multiple <tool_call> blocks per message", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "a ",
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>",
      " b ",
      "<tool_call><function=beta><parameter=y>2</parameter></function></tool_call>",
      " c",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    expect(out.map((x) => x.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    if (first?.type !== "tool-call" || second?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(first.toolName).toBe("alpha");
    expect(JSON.parse(first.input)).toEqual({ x: "1" });
    expect(second.toolName).toBe("beta");
    expect(JSON.parse(second.input)).toEqual({ y: "2" });
  });

  it("supports multiple function calls inside a single <tool_call> block", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "prefix ",
      `<tool_call>
  <function=alpha>
    <parameter=x>1</parameter>
  </function>
  <function=beta>
    <parameter=y> 2 </parameter>
    <parameter=y>3</parameter>
  </function>
</tool_call>`,
      " suffix",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    expect(out.map((x) => x.type)).toEqual([
      "text",
      "tool-call",
      "tool-call",
      "text",
    ]);

    const [alpha, beta] = out.filter((x) => x.type === "tool-call");
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: ["2", "3"] });
  });

  it("extractToolCallSegments returns raw <tool_call> segments in order", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const a = "<tool_call><function=a></function></tool_call>";
    const b = "<tool_call><function=b></function></tool_call>";
    const text = `prefix ${a} mid ${b} suffix`;

    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    expect(p.extractToolCallSegments({ text, tools })).toEqual([a, b]);
  });

  it("parses self-closing function tags in non-stream mode", () => {
    const p = qwen3CoderProtocol();
    const text = [
      "before ",
      "<tool_call><function=get_weather/></tool_call>",
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools: [] });
    expect(out).toHaveLength(3);

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: string;
        }
      | undefined;
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({});
  });
});
