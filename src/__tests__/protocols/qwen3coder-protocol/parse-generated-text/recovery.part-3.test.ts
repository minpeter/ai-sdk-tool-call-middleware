import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("recovery.test split 3", () => {
  const tools = emptyFunctionTools;

  it("preserves closed calls when <tool_call> has trailing non-call text", () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=alpha><parameter=x>1</parameter></function>oops</tool_call>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((part) => part.type === "tool-call");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("alpha");
    expect(JSON.parse(call.input)).toEqual({ x: "1" });
  });

  it("recovers trailing incomplete wrapperless call after complete wrapperless match", () => {
    const p = qwen3CoderProtocol();
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
    const text = "<function=get_weather><parameter=city>Tokyo</parameter>";

    const out = p.parseGeneratedText({ text, tools });
    const calls = out.filter((x) => x.type === "tool-call");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });

  it("preserves trailing text after bare <function=...> when </function> is missing", () => {
    const p = qwen3CoderProtocol();
    const text =
      "before <function=get_weather><parameter=city>Tokyo</parameter> after";

    const out = p.parseGeneratedText({ text, tools });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });

    const [, call] = out;
    if (call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });
});
