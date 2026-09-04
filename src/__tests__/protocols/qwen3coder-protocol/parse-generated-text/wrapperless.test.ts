import type { JSONValue, LanguageModelV4Content } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

type ParsedCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function parseWrapperless(text: string): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    text,
    tools: emptyFunctionTools,
    protocol: qwen3CoderProtocol(),
  });
}

function toolCalls(parts: LanguageModelV4Content[]): ParsedCall[] {
  return parts.filter((part): part is ParsedCall => part.type === "tool-call");
}

function assertCall(
  call: ParsedCall | undefined,
  toolName: string,
  expected: JSONValue
): void {
  if (!call) {
    throw new Error("Expected tool-call part");
  }
  expect(call.toolName).toBe(toolName);
  expect(JSON.parse(call.input)).toEqual(expected);
}

describe("qwen3CoderProtocol", () => {
  it("parses wrapperless <function> before an incomplete <tool_call>", () => {
    const out = parseWrapperless(
      "<function=alpha><parameter=x>1</parameter><tool_call"
    );
    const calls = toolCalls(out);
    expect(calls).toHaveLength(1);
    assertCall(calls[0], "alpha", { x: "1" });
    const texts = out.filter((part) => part.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe("<tool_call");
  });

  it("parses <function> blocks even when <tool_call> wrapper is missing", () => {
    const out = parseWrapperless(
      "before <function=alpha><parameter=x>1</parameter></function> after"
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: "text", text: "before " });
    expect(out[2]).toEqual({ type: "text", text: " after" });
    assertCall(toolCalls(out)[0], "alpha", { x: "1" });
  });

  it("parses wrapperless <function> calls even when wrapped <tool_call> blocks are present", () => {
    const out = parseWrapperless(
      "before <function=beta><parameter=y>2</parameter></function> middle <tool_call><function=alpha><parameter=x>1</parameter></function></tool_call> after"
    );
    expect(out.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "text",
      "tool-call",
      "text",
    ]);
    const calls = toolCalls(out);
    expect(calls).toHaveLength(2);
    assertCall(calls[0], "beta", { y: "2" });
    assertCall(calls[1], "alpha", { x: "1" });
  });

  it("parses wrapperless prefix before trailing incomplete <tool_call> recovery", () => {
    const out = parseWrapperless(
      "<function=alpha><parameter=x>1</parameter></function> between <tool_call><parameter=y>2"
    );
    const calls = toolCalls(out);
    expect(calls).toHaveLength(1);
    assertCall(calls[0], "alpha", { x: "1" });
    const text = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toContain(" between ");
    expect(text).toContain("<tool_call><parameter=y>2");
  });

  it("ignores stray leading </tool_call> close tags before a <function> block", () => {
    const out = parseWrapperless(
      "before </tool_call>\n<function=alpha><parameter=x>1</parameter></function> after"
    );
    const text = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text).toContain("before ");
    expect(text).toContain(" after");
    expect(text).not.toContain("</tool_call>");
    assertCall(toolCalls(out)[0], "alpha", { x: "1" });
  });
});
