import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { qwen3coder_tool_parser } from "../../core/protocols/qwen3coder-tool-parser-xml-protocol";

describe("qwen3coder_tool_parser", () => {
  it("parseGeneratedText extracts <tool_call> blocks and preserves surrounding text", () => {
    const p = qwen3coder_tool_parser();
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
    const p = qwen3coder_tool_parser();
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
    const p = qwen3coder_tool_parser();
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
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const a = "<tool_call><function=a></function></tool_call>";
    const b = "<tool_call><function=b></function></tool_call>";
    const text = `prefix ${a} mid ${b} suffix`;

    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    expect(p.extractToolCallSegments({ text, tools })).toEqual([a, b]);
  });

  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const bad =
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>";
    const text = `before ${bad} after`;
    const out = p.parseGeneratedText({
      text,
      tools,
      options: { onError },
    });

    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
    expect(rejoined).toContain(bad);
  });

  it("parses self-closing function tags in non-stream mode", () => {
    const p = qwen3coder_tool_parser();
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

  it("formatToolCall emits Qwen3CoderToolParser markup that round-trips through parseGeneratedText", () => {
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ x: "1", y: ["2", "3"] }),
    });

    expect(formatted).toContain("<tool_call>");
    expect(formatted).toContain("<function=test_tool>");
    expect(formatted).toContain("<parameter=x>1</parameter>");
    expect(formatted).toContain("<parameter=y>2</parameter>");
    expect(formatted).toContain("<parameter=y>3</parameter>");

    const parsed = p.parseGeneratedText({
      text: `prefix ${formatted} suffix`,
      tools,
    });
    const calls = parsed.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("test_tool");
    expect(JSON.parse(call.input)).toEqual({ x: "1", y: ["2", "3"] });
  });

  it("recovers missing </parameter> by terminating at the next parameter tag", () => {
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=a>1<parameter=b>2</parameter></function></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ a: "1", b: "2" });
  });

  it("parses <function> blocks even when <tool_call> wrapper is missing", () => {
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "before ",
      "<function=alpha><parameter=x>1</parameter></function>",
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });

    const call = out[1];
    if (call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });
  });

  it("ignores stray leading </tool_call> close tags before a <function> block", () => {
    const p = qwen3coder_tool_parser();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "before ",
      "</tool_call>\n",
      "<function=alpha><parameter=x>1</parameter></function>",
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    const rejoinedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    expect(rejoinedText).toContain("before ");
    expect(rejoinedText).toContain(" after");
    expect(rejoinedText).not.toContain("</tool_call>");

    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });
  });
});
