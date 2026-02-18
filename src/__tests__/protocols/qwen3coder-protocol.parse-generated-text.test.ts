import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../core/protocols/qwen3coder-protocol";

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

  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
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

  it("keeps original trailing text when incomplete <tool_call recovery fails", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = "How to type <tool_call in docs?";

    const out = p.parseGeneratedText({ text, tools });
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toBe(text);
  });

  it("parses wrapperless <function> before an incomplete <tool_call>", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = "<function=alpha><parameter=x>1</parameter><tool_call";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });

    const texts = out.filter((part) => part.type === "text");
    expect(texts).toHaveLength(1);
    const textPart = texts[0];
    if (!textPart || textPart.type !== "text") {
      throw new Error("Expected text part");
    }
    expect(textPart.text).toBe("<tool_call");
  });

  it("keeps original remainder text after parsed blocks when trailing <tool_call is invalid", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const validCall =
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>";
    const trailing = " trailing <tool_call in docs?";

    const out = p.parseGeneratedText({
      text: `${validCall}${trailing}`,
      tools,
    });

    const toolCall = out[0];
    if (toolCall?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(toolCall.toolName).toBe("alpha");
    expect(JSON.parse(toolCall.input)).toEqual({ x: "1" });
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toBe(trailing);
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

  it("formatToolCall emits Qwen3CoderProtocol markup that round-trips through parseGeneratedText", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ x: "1", y: ["2", "3"] }),
    });

    expect(formatted).toContain("<tool_call>");
    expect(formatted).toContain('<function="test_tool">');
    expect(formatted).toContain('<parameter="x">1</parameter>');
    expect(formatted).toContain('<parameter="y">2</parameter>');
    expect(formatted).toContain('<parameter="y">3</parameter>');

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

  it("formatToolCall serializes boolean/null values using Qwen3-Coder template string semantics", () => {
    const p = qwen3CoderProtocol();
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ strict: false, enabled: true, optional: null }),
    });

    expect(formatted).toContain('<parameter="strict">False</parameter>');
    expect(formatted).toContain('<parameter="enabled">True</parameter>');
    expect(formatted).toContain('<parameter="optional">None</parameter>');
  });

  it("formatToolCall quotes function and parameter shorthand names for round-trip safety", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "group/search tool",
      input: JSON.stringify({
        "icon/default": "star",
        "display name": "Weather",
      }),
    });

    expect(formatted).toContain('<function="group/search tool">');
    expect(formatted).toContain('<parameter="icon/default">star</parameter>');
    expect(formatted).toContain(
      '<parameter="display name">Weather</parameter>'
    );

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
    expect(call.toolName).toBe("group/search tool");
    expect(JSON.parse(call.input)).toEqual({
      "icon/default": "star",
      "display name": "Weather",
    });
  });

  it("recovers missing </parameter> by terminating at the next parameter tag", () => {
    const p = qwen3CoderProtocol();
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

  it("treats </call>, </tool>, and </invoke> as unclosed-parameter boundaries", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><call=alpha><parameter=x>1</call><tool=beta><parameter=y>2</tool><invoke=gamma><parameter=z>3</invoke></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(3);

    const [alpha, beta, gamma] = calls;
    if (
      alpha?.type !== "tool-call" ||
      beta?.type !== "tool-call" ||
      gamma?.type !== "tool-call"
    ) {
      throw new Error("Expected tool-call parts");
    }

    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
    expect(gamma.toolName).toBe("gamma");
    expect(JSON.parse(gamma.input)).toEqual({ z: "3" });
  });

  it("does not treat partial closing-tag prefixes like </toolbox> as call boundaries", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=query>How to close </toolbox> tag</function></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({
      query: "How to close </toolbox> tag",
    });
  });

  it("does not treat unrelated closing tags like </tool> as boundaries for <function> calls", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=query>How to use </tool> tag</function></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({
      query: "How to use </tool> tag",
    });
  });

  it("does not treat </name> text as a boundary for <tool_call> parameter recovery", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><name>alpha</name><parameter=query>How to close </name> tag</tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({
      query: "How to close </name> tag",
    });
  });

  it("prefers explicit </parameter> over boundary heuristic when value contains pseudo tags", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=query><![CDATA[How to use <function=beta> and <parameter=x> tags]]></parameter></function></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const call = out.find((part) => part.type === "tool-call");
    if (!call || call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({
      query: "How to use <function=beta> and <parameter=x> tags",
    });
  });

  it("parses <function> blocks even when <tool_call> wrapper is missing", () => {
    const p = qwen3CoderProtocol();
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

  it("parses wrapperless <function> calls even when wrapped <tool_call> blocks are present", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "before ",
      "<function=beta><parameter=y>2</parameter></function>",
      " middle ",
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>",
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    expect(out.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);

    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    if (first?.type !== "tool-call" || second?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }

    expect(first.toolName).toBe("beta");
    expect(JSON.parse(first.input)).toEqual({ y: "2" });
    expect(second.toolName).toBe("alpha");
    expect(JSON.parse(second.input)).toEqual({ x: "1" });
  });

  it("parses wrapperless prefix before trailing incomplete <tool_call> recovery", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<function=alpha><parameter=x>1</parameter></function> between <tool_call><parameter=y>2";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });

    const rejoinedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoinedText).toContain(" between ");
    expect(rejoinedText).toContain("<tool_call><parameter=y>2");
  });

  it("ignores stray leading </tool_call> close tags before a <function> block", () => {
    const p = qwen3CoderProtocol();
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

  it("parses a single <tool_call> when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });

  it("parses multiple <tool_call> blocks when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "a ",
      "<tool_call><function=alpha><parameter=x>1</parameter></tool_call>",
      " b ",
      "<tool_call><function=beta><parameter=y>2</parameter></tool_call>",
      " c",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("parses mixed <tool_call> blocks with and without </function>", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = [
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>",
      " and ",
      "<tool_call><function=beta><parameter=y>2</parameter></tool_call>",
    ].join("");

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("parses trailing recoverable malformed call inside one <tool_call> block", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=x>1</parameter></function><function=beta><parameter=y>2</parameter></tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("preserves closed calls when <tool_call> has trailing non-call text", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<tool_call><function=alpha><parameter=x>1</parameter></function>oops</tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });
  });

  it("recovers trailing incomplete wrapperless call after complete wrapperless match", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "<function=alpha><parameter=x>1</parameter></function> <function=beta><parameter=y>2</parameter>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(2);
    const [alpha, beta] = calls;
    if (alpha?.type !== "tool-call" || beta?.type !== "tool-call") {
      throw new Error("Expected tool-call parts");
    }
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: "2" });
  });

  it("parses a bare <function=...> call when </function> and <tool_call> are missing", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text = "<function=get_weather><parameter=city>Tokyo</parameter>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });

  it("preserves trailing text after bare <function=...> when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const tools: LanguageModelV3FunctionTool[] = [];
    const text =
      "before <function=get_weather><parameter=city>Tokyo</parameter> after";

    const out = p.parseGeneratedText({ text, tools });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });

    const call = out[1];
    if (call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });
});
