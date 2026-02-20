import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("qwen3CoderProtocol", () => {
  const tools = emptyFunctionTools;

  it("recovers missing </parameter> by terminating at the next parameter tag", () => {
    const p = qwen3CoderProtocol();
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
});
