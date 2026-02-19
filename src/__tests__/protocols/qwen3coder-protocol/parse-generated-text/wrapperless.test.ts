import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";

describe("qwen3CoderProtocol", () => {
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
});
