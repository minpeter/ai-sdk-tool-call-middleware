import { describe, expect, it, vi } from "vitest";

import { uiTarsXmlProtocol } from "../../core/protocols/ui-tars-xml-protocol";

describe("uiTarsXmlProtocol", () => {
  it("parseGeneratedText extracts <tool_call> blocks and preserves surrounding text", () => {
    const p = uiTarsXmlProtocol();
    const text = [
      "before ",
      `<tool_call>
  <name>search</name>
  <parameter name="query">
    AI
  </parameter>
  <parameter name="query"> ML </parameter>
  <parameter name="lang"> en </parameter>
</tool_call>`,
      " after",
    ].join("");

    const out = p.parseGeneratedText({ text, tools: [] as any });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });

    const toolCall = out[1] as any;
    expect(toolCall.type).toBe("tool-call");
    expect(toolCall.toolName).toBe("search");
    expect(JSON.parse(toolCall.input)).toEqual({
      query: ["AI", "ML"],
      lang: "en",
    });
  });

  it("supports multiple <tool_call> blocks per message", () => {
    const p = uiTarsXmlProtocol();
    const text = [
      "a ",
      `<tool_call><name>alpha</name><parameter name="x">1</parameter></tool_call>`,
      " b ",
      `<tool_call><name>beta</name><parameter name="y">2</parameter></tool_call>`,
      " c",
    ].join("");

    const out = p.parseGeneratedText({ text, tools: [] as any });
    expect(out.map((x) => x.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    const calls = out.filter((x) => x.type === "tool-call") as any[];
    expect(calls).toHaveLength(2);
    expect(calls[0].toolName).toBe("alpha");
    expect(JSON.parse(calls[0].input)).toEqual({ x: "1" });
    expect(calls[1].toolName).toBe("beta");
    expect(JSON.parse(calls[1].input)).toEqual({ y: "2" });
  });

  it("supports multiple function calls inside a single <tool_call> block", () => {
    const p = uiTarsXmlProtocol();
    const text = [
      "prefix ",
      `<tool_call>
  <call>
    <name>alpha</name>
    <parameter name="x">1</parameter>
  </call>
  <call name="beta">
    <parameter name="y"> 2 </parameter>
    <parameter name="y">3</parameter>
  </call>
</tool_call>`,
      " suffix",
    ].join("");

    const out = p.parseGeneratedText({ text, tools: [] as any });
    expect(out.map((x) => x.type)).toEqual([
      "text",
      "tool-call",
      "tool-call",
      "text",
    ]);

    const [alpha, beta] = out.filter((x) => x.type === "tool-call") as any[];
    expect(alpha.toolName).toBe("alpha");
    expect(JSON.parse(alpha.input)).toEqual({ x: "1" });
    expect(beta.toolName).toBe("beta");
    expect(JSON.parse(beta.input)).toEqual({ y: ["2", "3"] });
  });

  it("extractToolCallSegments returns raw <tool_call> segments in order", () => {
    const p = uiTarsXmlProtocol();
    const a = "<tool_call><name>a</name></tool_call>";
    const b = "<tool_call><name>b</name></tool_call>";
    const text = `prefix ${a} mid ${b} suffix`;

    if (!p.extractToolCallSegments) {
      throw new Error("extractToolCallSegments is not defined");
    }
    expect(p.extractToolCallSegments({ text, tools: [] as any })).toEqual([
      a,
      b,
    ]);
  });

  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const p = uiTarsXmlProtocol();
    const bad = `<tool_call><parameter name="x">1</parameter></tool_call>`;
    const text = `before ${bad} after`;
    const out = p.parseGeneratedText({
      text,
      tools: [] as any,
      options: { onError },
    });

    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
    expect(rejoined).toContain(bad);
  });

  it("formatToolCall emits UI-TARS markup that round-trips through parseGeneratedText", () => {
    const p = uiTarsXmlProtocol();
    const formatted = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "test_tool",
      input: JSON.stringify({ x: "1", y: ["2", "3"] }),
    } as any);

    expect(formatted).toContain("<tool_call>");
    expect(formatted).toContain("<name>test_tool</name>");
    expect(formatted).toContain('<parameter name="x">1</parameter>');
    expect(formatted).toContain('<parameter name="y">2</parameter>');
    expect(formatted).toContain('<parameter name="y">3</parameter>');

    const parsed = p.parseGeneratedText({
      text: `prefix ${formatted} suffix`,
      tools: [] as any,
    });
    const calls = parsed.filter((x) => x.type === "tool-call") as any[];
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("test_tool");
    expect(JSON.parse(calls[0].input)).toEqual({ x: "1", y: ["2", "3"] });
  });
});
