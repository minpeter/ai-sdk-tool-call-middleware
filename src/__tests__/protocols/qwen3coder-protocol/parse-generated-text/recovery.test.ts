import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("qwen3CoderProtocol", () => {
  const tools = emptyFunctionTools;

  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
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
    const text = "How to type <tool_call in docs?";

    const out = p.parseGeneratedText({ text, tools });
    const rejoined = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(rejoined).toBe(text);
  });

  it("keeps original remainder text after parsed blocks when trailing <tool_call is invalid", () => {
    const p = qwen3CoderProtocol();
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

  it("parses a single <tool_call> when </function> is missing", () => {
    const p = qwen3CoderProtocol();
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
    const call = calls[0];
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

    const call = out[1];
    if (call.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({ city: "Tokyo" });
  });
});
