import type { JSONValue, LanguageModelV4Content } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

type ToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function toolCalls(text: string): ToolCall[] {
  return qwen3CoderProtocol()
    .parseGeneratedText({ text, tools: emptyFunctionTools })
    .filter((part): part is ToolCall => part.type === "tool-call");
}

function expectSingleCall(
  text: string,
  toolName: string,
  input: Record<string, JSONValue>
): void {
  const [call] = toolCalls(text);
  if (call === undefined) {
    throw new Error("Expected tool-call part");
  }
  expect(call.toolName).toBe(toolName);
  expect(JSON.parse(call.input)).toEqual(input);
}

function expectThreeCalls(text: string): void {
  const calls = toolCalls(text);
  expect(calls).toHaveLength(3);
  expect(calls.map((call) => call.toolName)).toEqual([
    "alpha",
    "beta",
    "gamma",
  ]);
  expect(calls.map((call) => JSON.parse(call.input))).toEqual([
    { x: "1" },
    { y: "2" },
    { z: "3" },
  ]);
}

describe("qwen3CoderProtocol", () => {
  it("recovers missing </parameter> by terminating at the next parameter tag", () => {
    expectSingleCall(
      "<tool_call><function=alpha><parameter=a>1<parameter=b>2</parameter></function></tool_call>",
      "alpha",
      { a: "1", b: "2" }
    );
  });

  it("treats </call>, </tool>, and </invoke> as unclosed-parameter boundaries", () => {
    expectThreeCalls(
      "<tool_call><call=alpha><parameter=x>1</call><tool=beta><parameter=y>2</tool><invoke=gamma><parameter=z>3</invoke></tool_call>"
    );
  });

  it("terminates unclosed parameter values at the next alternate call opener", () => {
    expectThreeCalls(
      "<tool_call><call=alpha><parameter=x>1<tool=beta><parameter=y>2</tool><invoke=gamma><parameter=z>3</invoke></tool_call>"
    );
  });

  it("does not treat partial closing-tag prefixes like </toolbox> as call boundaries", () => {
    expectSingleCall(
      "<tool_call><function=alpha><parameter=query>How to close </toolbox> tag</function></tool_call>",
      "alpha",
      { query: "How to close </toolbox> tag" }
    );
  });

  it("does not treat unrelated closing tags like </tool> as boundaries for <function> calls", () => {
    expectSingleCall(
      "<tool_call><function=alpha><parameter=query>How to use </tool> tag</function></tool_call>",
      "alpha",
      { query: "How to use </tool> tag" }
    );
  });

  it("does not treat </name> text as a boundary for <tool_call> parameter recovery", () => {
    expectSingleCall(
      "<tool_call><name>alpha</name><parameter=query>How to close </name> tag</tool_call>",
      "alpha",
      { query: "How to close </name> tag" }
    );
  });

  it("prefers explicit </parameter> over boundary heuristic when value contains pseudo tags", () => {
    expectSingleCall(
      "<tool_call><function=alpha><parameter=query><![CDATA[How to use <function=beta> and <parameter=x> tags]]></parameter></function></tool_call>",
      "alpha",
      { query: "How to use <function=beta> and <parameter=x> tags" }
    );
  });

  it("does not cut unclosed parameter values at tag-name prefixes inside text", () => {
    expectSingleCall(
      "<tool_call><function=alpha><parameter=query>How to spell <parameters> and <functions> tokens</function></tool_call>",
      "alpha",
      { query: "How to spell <parameters> and <functions> tokens" }
    );
  });
});
