import type { JSONValue, LanguageModelV4Content } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

type QwenCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

function recover(text: string): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    protocol: qwen3CoderProtocol(),
    text,
    tools: emptyFunctionTools,
  });
}

function calls(output: LanguageModelV4Content[]): QwenCall[] {
  return output.filter((part): part is QwenCall => part.type === "tool-call");
}

function expectCall(
  call: QwenCall | undefined,
  name: string,
  input: JSONValue
): void {
  expect(call?.toolName).toBe(name);
  expect(JSON.parse(call?.input ?? "{}")).toEqual(input);
}

describe("recovery.test split 3", () => {
  it("preserves closed calls when <tool_call> has trailing non-call text", () => {
    const found = calls(
      recover(
        "<tool_call><function=alpha><parameter=x>1</parameter></function>oops</tool_call>"
      )
    );
    expect(found).toHaveLength(1);
    expectCall(found[0], "alpha", { x: "1" });
  });

  it("recovers trailing incomplete wrapperless call after complete wrapperless match", () => {
    const found = calls(
      recover(
        "<function=alpha><parameter=x>1</parameter></function> <function=beta><parameter=y>2</parameter>"
      )
    );
    expect(found).toHaveLength(2);
    expectCall(found[0], "alpha", { x: "1" });
    expectCall(found[1], "beta", { y: "2" });
  });

  it("parses a bare <function=...> call when </function> and <tool_call> are missing", () => {
    const found = calls(
      recover("<function=get_weather><parameter=city>Tokyo</parameter>")
    );
    expect(found).toHaveLength(1);
    expectCall(found[0], "get_weather", { city: "Tokyo" });
  });

  it("preserves trailing text after bare <function=...> when </function> is missing", () => {
    const out = recover(
      "before <function=get_weather><parameter=city>Tokyo</parameter> after"
    );
    expect(out).toMatchObject([
      { type: "text", text: "before " },
      { type: "tool-call", toolName: "get_weather" },
      { type: "text", text: " after" },
    ]);
    expectCall(calls(out)[0], "get_weather", { city: "Tokyo" });
  });
});
