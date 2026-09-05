import type {
  JSONValue,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { uiTarsXmlProtocol } from "../../../../core/protocols/compat-aliases";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { TCMProtocol } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runStreamingEventCase,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

type DeltaJoinExpectation = "equal" | "diverges";
type GeneratedToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;

interface LiteralExpectation {
  readonly deltaJoinExpectation: DeltaJoinExpectation;
  readonly excluded: readonly string[];
  readonly expectedValue: string;
  readonly included: readonly string[];
  readonly protocol: TCMProtocol;
  readonly rawModelOutput: string;
}

function assertIncludesAll(
  value: string,
  needles: readonly string[],
  label: string
): void {
  for (const needle of needles) {
    if (!value.includes(needle)) {
      throw new Error(`${label}: missing '${needle}' in '${value}'`);
    }
  }
}

function assertExcludesAll(
  value: string,
  needles: readonly string[],
  label: string
): void {
  for (const needle of needles) {
    if (value.includes(needle)) {
      throw new Error(`${label}: unexpected '${needle}' in '${value}'`);
    }
  }
}

function requireGeneratedToolCall(parts: readonly LanguageModelV4Content[]) {
  const toolCall = parts.find(
    (part): part is GeneratedToolCall =>
      part.type === "tool-call" && part.toolName === "send_keys"
  );
  expect(toolCall).toBeTruthy();
  if (toolCall === undefined) {
    throw new Error("Expected parsed send_keys tool-call");
  }
  return toolCall;
}

function requireStringValue(input: JSONValue): string {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.value !== "string"
  ) {
    throw new TypeError("Expected string tool input value");
  }
  return input.value;
}

function assertLiteralValue(expectation: LiteralExpectation, value: string) {
  expect(value).toBe(expectation.expectedValue);
  assertIncludesAll(value, expectation.included, "literal value");
  assertExcludesAll(value, expectation.excluded, "literal value");
}

function assertGeneratedLiteral(
  expectation: LiteralExpectation,
  declaredTools: LanguageModelV4FunctionTool[]
): void {
  const parsed = expectation.protocol.parseGeneratedText({
    text: expectation.rawModelOutput,
    tools: declaredTools,
  });
  const toolCall = requireGeneratedToolCall(parsed);
  const input = parseToolCallObject({
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input,
  });

  expect(input).toEqual({ value: expectation.expectedValue });
  assertLiteralValue(expectation, requireStringValue(input));
}

async function assertStreamedLiteral(
  expectation: LiteralExpectation,
  declaredTools: LanguageModelV4FunctionTool[]
): Promise<void> {
  const out = await runStreamingEventCase({
    protocol: expectation.protocol,
    tools: declaredTools,
    chunks: expectation.rawModelOutput.split(""),
    id: "fixture",
  });
  const toolCall = requireToolCall(out);
  expect(toolCall).toBeTruthy();
  const input = parseToolCallObject(toolCall);
  expect(input).toEqual({ value: expectation.expectedValue });
  assertLiteralValue(expectation, requireStringValue(input));

  const deltas = selectToolInputTimeline(out).deltas.filter(
    (part) => part.id === toolCall.toolCallId
  );
  expect(deltas.length).toBeGreaterThan(0);
  const joined = deltas.map((part) => part.delta).join("");
  if (expectation.deltaJoinExpectation === "equal") {
    expect(joined).toBe(toolCall.input);
    const deltaInput: JSONValue = JSON.parse(joined);
    expect(deltaInput).toEqual({ value: expectation.expectedValue });
    assertLiteralValue(expectation, requireStringValue(deltaInput));
    return;
  }
  expect(joined).not.toBe(toolCall.input);
  expect(joined.startsWith('{"value":"')).toBe(true);
}

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "send_keys",
    description: "Send terminal key sequence",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
];

const literalValue = "<Ctrl+C>ahi, my name is pi<Esc><Enter>";
const literalIncluded = ["<Ctrl+C>", "<Esc>", "<Enter>"];
const literalExcluded = ["&lt;", "&gt;", "&amp;"];

const literalScenarios = [
  {
    name: "hermes",
    protocol: hermesProtocol(),
    variants: [
      {
        name: "escaped-sequence input",
        rawModelOutput:
          '<tool_call>{"name":"send_keys","arguments":{"value":"\\u003cCtrl+C\\u003eahi, my name is pi\\u003cEsc\\u003e\\u003cEnter\\u003e"}}</tool_call>',
        deltaJoinExpectation: "equal",
      },
      {
        name: "raw-angle input",
        rawModelOutput:
          '<tool_call>{"name":"send_keys","arguments":{"value":"<Ctrl+C>ahi, my name is pi<Esc><Enter>"}}</tool_call>',
        deltaJoinExpectation: "equal",
      },
    ],
  },
  {
    name: "morph-xml",
    protocol: morphXmlProtocol(),
    variants: [
      {
        name: "entity-escaped input",
        rawModelOutput:
          "<send_keys><value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</value></send_keys>",
        deltaJoinExpectation: "equal",
      },
      {
        name: "raw-angle input",
        rawModelOutput:
          "<send_keys><value><Ctrl+C>ahi, my name is pi<Esc><Enter></value></send_keys>",
        deltaJoinExpectation: "equal",
      },
    ],
  },
  {
    name: "yaml-xml",
    protocol: yamlXmlProtocol(),
    variants: [
      {
        name: "escaped-sequence input",
        rawModelOutput:
          '<send_keys>\nvalue: "\\u003cCtrl+C\\u003eahi, my name is pi\\u003cEsc\\u003e\\u003cEnter\\u003e"\n</send_keys>',
        deltaJoinExpectation: "equal",
      },
      {
        name: "raw-angle input",
        rawModelOutput:
          "<send_keys>\nvalue: '<Ctrl+C>ahi, my name is pi<Esc><Enter>'\n</send_keys>",
        deltaJoinExpectation: "equal",
      },
    ],
  },
  {
    name: "qwen3coder",
    protocol: qwen3CoderProtocol(),
    variants: [
      {
        name: "entity-escaped input",
        rawModelOutput:
          "<tool_call><function=send_keys><parameter=value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</parameter></function></tool_call>",
        deltaJoinExpectation: "diverges",
      },
      {
        name: "raw-angle input",
        rawModelOutput:
          "<tool_call><function=send_keys><parameter=value><Ctrl+C>ahi, my name is pi<Esc><Enter></parameter></function></tool_call>",
        deltaJoinExpectation: "equal",
      },
    ],
  },
  {
    name: "ui-tars-xml-alias-coverage",
    protocol: uiTarsXmlProtocol(),
    variants: [
      {
        name: "entity-escaped input",
        rawModelOutput:
          "<tool_call><function=send_keys><parameter=value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</parameter></function></tool_call>",
        deltaJoinExpectation: "diverges",
      },
      {
        name: "raw-angle input",
        rawModelOutput:
          "<tool_call><function=send_keys><parameter=value><Ctrl+C>ahi, my name is pi<Esc><Enter></parameter></function></tool_call>",
        deltaJoinExpectation: "equal",
      },
    ],
  },
] as const;

describe("cross-protocol tool-input streaming events: literal angle-bracket arg values", () => {
  for (const scenario of literalScenarios) {
    for (const variant of scenario.variants) {
      const expectation: LiteralExpectation = {
        protocol: scenario.protocol,
        rawModelOutput: variant.rawModelOutput,
        deltaJoinExpectation: variant.deltaJoinExpectation,
        expectedValue: literalValue,
        included: literalIncluded,
        excluded: literalExcluded,
      };
      it(`${scenario.name} ${variant.name} parseGeneratedText keeps literal '<' and '>'`, () => {
        assertGeneratedLiteral(expectation, tools);
      });
      it(`${scenario.name} ${variant.name} stream parser keeps literal '<' and '>'`, async () => {
        await assertStreamedLiteral(expectation, tools);
      });
    }
  }
});

const entityLiteralValue =
  "&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;";
const entityIncluded = ["&lt;Ctrl+C&gt;", "&lt;Esc&gt;", "&lt;Enter&gt;"];
const entityExcluded = ["<Ctrl+C>", "<Esc>", "<Enter>", "&amp;"];
const entityScenarios = [
  {
    name: "morph-xml",
    protocol: morphXmlProtocol(),
    rawModelOutput:
      "<send_keys><value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</value></send_keys>",
    deltaJoinExpectation: "equal",
  },
  {
    name: "qwen3coder",
    protocol: qwen3CoderProtocol(),
    rawModelOutput:
      "<tool_call><function=send_keys><parameter=value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</parameter></function></tool_call>",
    deltaJoinExpectation: "diverges",
  },
  {
    name: "ui-tars-xml-alias-coverage",
    protocol: uiTarsXmlProtocol(),
    rawModelOutput:
      "<tool_call><function=send_keys><parameter=value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</parameter></function></tool_call>",
    deltaJoinExpectation: "diverges",
  },
] as const;

describe("cross-protocol tool-input streaming events: double-escaped entity literals", () => {
  for (const scenario of entityScenarios) {
    const expectation: LiteralExpectation = {
      protocol: scenario.protocol,
      rawModelOutput: scenario.rawModelOutput,
      deltaJoinExpectation: scenario.deltaJoinExpectation,
      expectedValue: entityLiteralValue,
      included: entityIncluded,
      excluded: entityExcluded,
    };
    it(`${scenario.name} parseGeneratedText turns '&amp;lt;' into literal '&lt;' text`, () => {
      assertGeneratedLiteral(expectation, tools);
    });
    it(`${scenario.name} stream parser turns '&amp;lt;' into literal '&lt;' text`, async () => {
      await assertStreamedLiteral(expectation, tools);
    });
  }
});
