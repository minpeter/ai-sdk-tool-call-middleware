import {
  isJSONObject,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type {
  ParserOptions,
  ProtocolMetadata,
} from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "book_flight",
    inputSchema: {
      type: "object",
      properties: {
        passenger: { type: "object" },
        legs: { type: "array" },
        cabin: { type: "string" },
      },
    },
  },
];

const HERMES_JSON_UNDER_QWEN = `<tool_call>
{"name": "book_flight", "arguments": {"passenger": {"name": "Jane Doe", "age": 34}, "legs": [{"from": "ICN", "to": "NRT"}], "cabin": "economy", "seat": "12A"}}
</tool_call>`;

function runForeignStream(
  text: string,
  selectedTools: LanguageModelV4FunctionTool[] = tools,
  parserOptions?: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks: [...text],
    id: "1",
    protocol: qwen3CoderProtocol(),
    tools: selectedTools,
    parserOptions,
  });
}

function expectRejectedStream(
  output: readonly LanguageModelV4StreamPart[],
  errors: readonly string[],
  expectsInputEnd: boolean
): void {
  expect(selectToolCalls(output)).toHaveLength(0);
  if (expectsInputEnd) {
    expect(output.some((part) => part.type === "tool-input-end")).toBe(true);
  }
  expect(errors.length).toBeGreaterThan(0);
}

function payloadTools(): LanguageModelV4FunctionTool[] {
  return [
    {
      type: "function",
      name: "book_flight",
      inputSchema: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
    },
  ];
}

interface ClosedArgumentScenario {
  readonly name: string;
  readonly parameterName: string;
}

interface RedactionScenario {
  readonly forbidden: string;
  readonly name: string;
  readonly parameter: string;
}

interface NestedSensitiveScenario {
  readonly forbidden: string;
  readonly name: string;
  readonly nestedMarkup: string;
}

interface RawFallbackScenario {
  readonly name: string;
  readonly raw: string;
}

describe("qwen3CoderProtocol foreign-format salvage", () => {
  it("salvages a Hermes-style JSON payload inside tool_call tags (stream)", async () => {
    const out = await runForeignStream(HERMES_JSON_UNDER_QWEN);
    const [call] = selectToolCalls(out);
    if (call === undefined) {
      throw new TypeError("Expected tool-call stream part");
    }
    expect(call.toolName).toBe("book_flight");
    const input = JSON.parse(call.input);
    if (!isJSONObject(input)) {
      throw new TypeError("Expected tool input to be a JSON object");
    }
    expect(input.passenger).toEqual({ name: "Jane Doe", age: 34 });
    expect(input.legs).toEqual([{ from: "ICN", to: "NRT" }]);
    expect(input.seat).toBeUndefined();
    const { deltas } = selectToolInputTimeline(out);
    expect(deltas.map((part) => part.delta).join("")).not.toContain("seat");
    expect(collectTextDeltas(out)).toBe("");
  });

  it("still drops prose-only tool_call blocks with onError", async () => {
    const errors: string[] = [];
    const out = await runForeignStream(
      "<tool_call>\nsome prose, not a call\n",
      tools,
      { onError: (message) => errors.push(message) }
    );
    expectRejectedStream(out, errors, false);
  });

  for (const scenario of [
    {
      name: "fails closed without throwing on prototype-sensitive XML args",
      parameterName: "constructor",
    },
    {
      name: "fails closed without throwing on __proto__ XML args",
      parameterName: "__proto__",
    },
  ] satisfies readonly ClosedArgumentScenario[]) {
    it(scenario.name, async () => {
      const { parameterName } = scenario;
      const errors: string[] = [];
      const text = `<tool_call>\n<function=book_flight>\n<parameter=${parameterName}>{"polluted":true}</parameter>\n</function>\n</tool_call>`;
      const out = await runForeignStream(text, tools, {
        onError: (message) => errors.push(message),
      });
      expectRejectedStream(out, errors, true);
    });
  }

  for (const scenario of [
    {
      name: "redacts raw fallback for prototype-sensitive parameter name attributes",
      parameter: 'name="constructor"',
      forbidden: "constructor",
    },
    {
      name: "redacts raw fallback for entity-encoded prototype-sensitive parameter name attributes",
      parameter: 'name="&#99;onstructor"',
      forbidden: "&#99;onstructor",
    },
  ] satisfies readonly RedactionScenario[]) {
    it(scenario.name, async () => {
      const { forbidden, parameter } = scenario;
      const errors: [string, ProtocolMetadata | undefined][] = [];
      const text = `<tool_call>\n<function=book_flight>\n<param ${parameter}>{"polluted":true}</param>\n</function>\n</tool_call>`;
      const out = await runForeignStream(text, tools, {
        emitRawToolCallTextOnError: true,
        onError: (message, metadata) => errors.push([message, metadata]),
      });
      expect(selectToolCalls(out)).toHaveLength(0);
      expect(collectTextDeltas(out)).toBe("");
      expect(errors.length).toBeGreaterThan(0);
      const metadataText = JSON.stringify(errors);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(forbidden);
      expect(metadataText).not.toContain("<tool_call>");
    });
  }

  for (const scenario of [
    {
      name: "fails closed on prototype-sensitive XML child tags embedded inside string arg values",
      nestedMarkup: "<prototype>x</prototype>",
      forbidden: "prototype",
    },
    {
      name: "fails closed on unquoted-name prototype-sensitive XML child params embedded inside string arg values",
      nestedMarkup: '<parameter name=constructor>{"polluted":true}</parameter>',
      forbidden: "constructor",
    },
  ] satisfies readonly NestedSensitiveScenario[]) {
    it(scenario.name, async () => {
      const { forbidden, nestedMarkup } = scenario;
      const errors: string[] = [];
      const text = `<tool_call>\n<function=book_flight>\n<parameter=payload>${nestedMarkup}</parameter>\n</function>\n</tool_call>`;
      const out = await runForeignStream(text, payloadTools(), {
        onError: (message) => errors.push(message),
      });
      expect(selectToolCalls(out)).toHaveLength(0);
      expect(out.some((part) => part.type === "tool-input-end")).toBe(true);
      const { deltas } = selectToolInputTimeline(out);
      expect(deltas.map((part) => part.delta).join("")).not.toContain(
        forbidden
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  }

  for (const scenario of [
    {
      name: "emits raw text instead of salvaging XML calls mixed with trailing prose",
      raw: '<tool_call name="book_flight"><cabin>economy</cabin>\nvisible prose',
    },
    {
      name: "emits raw text instead of salvaging prose-only named unfinished blocks",
      raw: '<tool_call name="book_flight">visible prose only',
    },
    {
      name: "emits raw text instead of salvaging XML calls mixed with leading prose",
      raw: '<tool_call name="book_flight">visible prose\n<cabin>economy</cabin>',
    },
  ] satisfies readonly RawFallbackScenario[]) {
    it(scenario.name, async () => {
      const { raw } = scenario;
      const out = await runForeignStream(raw, tools, {
        emitRawToolCallTextOnError: true,
      });
      expect(selectToolCalls(out)).toHaveLength(0);
      expect(collectTextDeltas(out)).toBe(raw);
    });
  }
});
