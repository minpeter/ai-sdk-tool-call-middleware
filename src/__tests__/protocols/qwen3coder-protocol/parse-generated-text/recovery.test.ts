import type * as Provider from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

const flightTool: Provider.LanguageModelV4FunctionTool = {
  name: "book_flight",
  type: "function",
  inputSchema: {
    properties: { cabin: { type: "string" } },
    type: "object",
  },
};

function parsePrimary(
  text: string,
  parserOptions?: ParserOptions,
  tools: Provider.LanguageModelV4FunctionTool[] = emptyFunctionTools
): Provider.LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    tools,
    text,
    protocol: qwen3CoderProtocol(),
    parserOptions,
  });
}

function textContent(parts: Provider.LanguageModelV4Content[]): string {
  let text = "";
  for (const part of parts) {
    if (part.type === "text") {
      text += part.text;
    }
  }
  return text;
}

function expectRedacted(
  onError: ReturnType<typeof vi.fn>,
  hidden: string
): void {
  expect(onError).toHaveBeenCalled();
  const metadataText = JSON.stringify(onError.mock.calls);
  expect(metadataText).toContain("[redacted sensitive tool call]");
  expect(metadataText).not.toContain(hidden);
}

const sensitiveNames: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

function verifySensitiveParameter(
  parameterName: string,
  text: string,
  expectedInput: string,
  expectedText: string,
  hidden: string = parameterName,
  checksParameterMarkup = true
): string {
  const onError = vi.fn();
  const out = parsePrimary(
    text,
    { emitRawToolCallTextOnError: true, onError },
    [flightTool]
  );
  expect(out.find((part) => part.type === "tool-call")).toMatchObject({
    type: "tool-call",
    toolName: "book_flight",
    input: expectedInput,
  });
  expect(textContent(out)).toBe(expectedText);
  expectRedacted(onError, hidden);
  const metadataText = JSON.stringify(onError.mock.calls);
  if (checksParameterMarkup) {
    expect(metadataText).not.toContain("<parameter=");
  }
  return metadataText;
}

const rejectedCallCases = [
  {
    name: "calls onError and drops raw text on prototype-sensitive args",
    text: '<tool_call><function=book_flight><parameter=constructor>{"polluted":true}</parameter></function></tool_call>',
    checksRedactedError: true,
  },
  {
    name: "calls onError and drops raw text on self-closing prototype-sensitive args",
    text: "<tool_call><function=book_flight><parameter=constructor/></function></tool_call>",
    checksRedactedError: false,
  },
  {
    name: "calls onError and drops raw text on __proto__ parameter args",
    text: '<tool_call><function=book_flight><parameter=__proto__>{"polluted":true}</parameter></function></tool_call>',
    checksRedactedError: false,
  },
];

describe("recovery.test split 1", () => {
  it("calls onError and keeps original text on malformed segments", () => {
    const onError = vi.fn();
    const bad =
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>";
    const out = parsePrimary(`before ${bad} after`, { onError });
    expect(onError).toHaveBeenCalled();
    expect(textContent(out)).toContain(bad);
  });

  for (const scenario of rejectedCallCases) {
    it(scenario.name, () => {
      const onError = vi.fn();
      const out = parsePrimary(scenario.text, { onError }, [flightTool]);
      expect(out.some((part) => part.type === "tool-call")).toBe(false);
      expect(textContent(out)).toBe("");
      if (scenario.checksRedactedError) {
        expect(onError).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: "[redacted sensitive tool call]" })
        );
      } else {
        expect(onError).toHaveBeenCalled();
      }
    });
  }

  for (const parameterName of sensitiveNames) {
    it(`drops wrapperless partial prototype-sensitive arg trailing text for ${parameterName}`, () => {
      verifySensitiveParameter(
        parameterName,
        `<function=book_flight><parameter=${parameterName}`,
        "{}",
        ""
      );
    });

    it(`drops standalone prototype-sensitive parameter trailing text after wrapperless call for ${parameterName}`, () => {
      verifySensitiveParameter(
        parameterName,
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
          `<parameter=${parameterName}>{"polluted":true}</parameter>`,
        '{"cabin":"economy"}',
        ""
      );
    });

    it(`preserves safe text after dropped standalone prototype-sensitive parameter trailing text for ${parameterName}`, () => {
      verifySensitiveParameter(
        parameterName,
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
          `<parameter=${parameterName}>{"polluted":true}</parameter> after`,
        '{"cabin":"economy"}',
        " after"
      );
    });
  }

  it("preserves safe text after dropped entity-encoded standalone prototype-sensitive parameter trailing text", () => {
    const text =
      "<function=book_flight><parameter=cabin>economy</parameter></function>" +
      '<parameter name="&#99;onstructor">{"polluted":true}</parameter> after';
    const metadataText = verifySensitiveParameter(
      "encoded-constructor",
      text,
      '{"cabin":"economy"}',
      " after",
      "polluted",
      false
    );
    expect(metadataText).not.toContain("&#99;onstructor");
  });

  it("preserves safe text after dropped unquoted-name standalone prototype-sensitive parameter trailing text", () => {
    const text =
      "<function=book_flight><parameter=cabin>economy</parameter></function>" +
      '<parameter name=constructor>{"polluted":true}</parameter> after';
    const metadataText = verifySensitiveParameter(
      "unquoted-constructor",
      text,
      '{"cabin":"economy"}',
      " after",
      "polluted",
      false
    );
    expect(metadataText).not.toContain("name=constructor");
  });

  it("drops bare standalone prototype-sensitive parameter text without a wrapperless call", () => {
    const onError = vi.fn();
    const out = parsePrimary(
      "safe<parameter=__proto__>leakmarker</parameter> tail",
      { emitRawToolCallTextOnError: true, onError },
      [flightTool]
    );
    expect(textContent(out)).toBe("safe tail");
    expect(JSON.stringify(out)).not.toContain("leakmarker");
    expectRedacted(onError, "leakmarker");
    expect(JSON.stringify(onError.mock.calls)).not.toContain("<parameter=");
  });
});
