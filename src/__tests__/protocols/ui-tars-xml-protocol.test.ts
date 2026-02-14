import { describe, expect, it, vi } from "vitest";

import { uiTarsXmlProtocol } from "../../core/protocols/ui-tars-xml-protocol";

describe("uiTarsXmlProtocol", () => {
  it("parseGeneratedText extracts <tool_call> blocks and preserves surrounding text", () => {
    const p = uiTarsXmlProtocol();
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
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>",
      " b ",
      "<tool_call><function=beta><parameter=y>2</parameter></function></tool_call>",
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
    const a = "<tool_call><function=a></function></tool_call>";
    const b = "<tool_call><function=b></function></tool_call>";
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
    const bad =
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>";
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
    expect(formatted).toContain("<function=test_tool>");
    expect(formatted).toContain("<parameter=x>1</parameter>");
    expect(formatted).toContain("<parameter=y>2</parameter>");
    expect(formatted).toContain("<parameter=y>3</parameter>");

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
