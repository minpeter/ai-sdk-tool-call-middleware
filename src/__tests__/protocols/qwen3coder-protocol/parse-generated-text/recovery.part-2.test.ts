import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

type RecoveryCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

const bookFlightTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "book_flight",
  inputSchema: {
    type: "object",
    properties: { cabin: { type: "string" } },
  },
};

const payloadTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "book_flight",
  inputSchema: {
    type: "object",
    properties: { payload: { type: "string" } },
  },
};

function recoverText(
  text: string,
  tools: LanguageModelV4FunctionTool[] = emptyFunctionTools,
  parserOptions?: ParserOptions
): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    text,
    tools,
    parserOptions,
    protocol: qwen3CoderProtocol(),
  });
}

function joinedText(output: LanguageModelV4Content[]): string {
  return output
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function callsIn(output: LanguageModelV4Content[]): RecoveryCall[] {
  return output.filter(
    (part): part is RecoveryCall => part.type === "tool-call"
  );
}

function assertRecoveredCall(
  call: RecoveryCall | undefined,
  name: string,
  input: JSONValue
): void {
  if (!call) {
    throw new Error("Expected tool-call part");
  }
  expect(call.toolName).toBe(name);
  expect(JSON.parse(call.input)).toEqual(input);
}

const redactionCases = [
  {
    name: "redacts raw fallback for prototype-sensitive parameter name attributes",
    text: '<tool_call><function=book_flight><parameter name="constructor">{"polluted":true}</parameter></function></tool_call>',
    hidden: "constructor",
  },
  {
    name: "redacts raw fallback for entity-encoded prototype-sensitive parameter name attributes",
    text: '<tool_call><function=book_flight><parameter name="&#99;onstructor">{"polluted":true}</parameter></function></tool_call>',
    hidden: "&#99;onstructor",
  },
];

const embeddedCases = [
  {
    name: "drops prototype-sensitive XML child tags embedded inside string arg values",
    text: "<tool_call><function=book_flight><parameter=payload><prototype>x</prototype></parameter></function></tool_call>",
  },
  {
    name: "drops unquoted-name prototype-sensitive XML child params embedded inside string arg values",
    text: '<tool_call><function=book_flight><parameter=payload><parameter name=constructor>{"polluted":true}</parameter></parameter></function></tool_call>',
  },
];

function verifyRedaction(scenario: (typeof redactionCases)[number]): void {
  const onError = vi.fn();
  const out = recoverText(scenario.text, [bookFlightTool], {
    emitRawToolCallTextOnError: true,
    onError,
  });
  expect(callsIn(out)).toHaveLength(0);
  expect(joinedText(out).length).toBe(0);
  expect(onError.mock.calls.length).toBeGreaterThan(0);
  const metadataText = JSON.stringify(onError.mock.calls);
  expect(metadataText.includes("[redacted sensitive tool call]")).toBe(true);
  expect(metadataText.includes(scenario.hidden)).toBe(false);
  expect(metadataText.includes("<tool_call>")).toBe(false);
}

const twoCallCases = [
  {
    name: "parses multiple <tool_call> blocks when </function> is missing",
    text: "a <tool_call><function=alpha><parameter=x>1</parameter></tool_call> b <tool_call><function=beta><parameter=y>2</parameter></tool_call> c",
  },
  {
    name: "parses mixed <tool_call> blocks with and without </function>",
    text: "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call> and <tool_call><function=beta><parameter=y>2</parameter></tool_call>",
  },
  {
    name: "parses trailing recoverable malformed call inside one <tool_call> block",
    text: "<tool_call><function=alpha><parameter=x>1</parameter></function><function=beta><parameter=y>2</parameter></tool_call>",
  },
];

describe("recovery.test split 2", () => {
  for (const scenario of redactionCases) {
    it(scenario.name, () => verifyRedaction(scenario));
  }

  for (const scenario of embeddedCases) {
    it(scenario.name, () => {
      const onError = vi.fn();
      const out = recoverText(scenario.text, [payloadTool], { onError });
      expect(callsIn(out)).toHaveLength(0);
      expect(joinedText(out)).toBe("");
      expect(onError).toHaveBeenCalled();
    });
  }

  it("preserves ordinary prose that mentions constructor as a label", () => {
    const onError = vi.fn();
    const text = "constructor: ordinary prose";
    const out = recoverText(text, emptyFunctionTools, {
      emitRawToolCallTextOnError: true,
      onError,
    });
    expect(joinedText(out)).toBe(text);
    expect(onError).not.toHaveBeenCalled();
  });

  for (const cabin of [
    "constructor: ordinary prose",
    "prototype: ordinary prose",
    "constructor: true",
  ]) {
    it(`preserves schema-valid string parameter value ${cabin}`, () => {
      const onError = vi.fn();
      const text = `<tool_call><function=book_flight><parameter=cabin>${cabin}</parameter></function></tool_call>`;
      const [call] = callsIn(recoverText(text, [bookFlightTool], { onError }));
      assertRecoveredCall(call, "book_flight", { cabin });
      expect(onError).not.toHaveBeenCalled();
    });
  }

  it("keeps original trailing text when incomplete <tool_call recovery fails", () => {
    const text = "How to type <tool_call in docs?";
    expect(joinedText(recoverText(text))).toBe(text);
  });

  it("keeps original remainder text after parsed blocks when trailing <tool_call is invalid", () => {
    const validCall =
      "<tool_call><function=alpha><parameter=x>1</parameter></function></tool_call>";
    const trailing = " trailing <tool_call in docs?";
    const out = recoverText(`${validCall}${trailing}`);
    assertRecoveredCall(callsIn(out)[0], "alpha", { x: "1" });
    expect(joinedText(out)).toBe(trailing);
  });

  it("parses a single <tool_call> when </function> is missing", () => {
    const out = recoverText(
      "<tool_call><function=get_weather><parameter=city>Tokyo</parameter></tool_call>"
    );
    const calls = callsIn(out);
    expect(calls).toHaveLength(1);
    assertRecoveredCall(calls[0], "get_weather", { city: "Tokyo" });
  });

  for (const scenario of twoCallCases) {
    it(scenario.name, () => {
      const calls = callsIn(recoverText(scenario.text));
      expect(calls).toHaveLength(2);
      assertRecoveredCall(calls[0], "alpha", { x: "1" });
      assertRecoveredCall(calls[1], "beta", { y: "2" });
    });
  }
});
