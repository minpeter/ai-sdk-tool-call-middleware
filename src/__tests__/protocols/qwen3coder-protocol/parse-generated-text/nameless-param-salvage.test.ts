import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { stopFinishReason, zeroUsage } from "../../../test-helpers";
import {
  collectProtocolStream,
  collectTextDeltas,
  runGeneratedJsonRepair,
  runProtocolTextStream,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

// Real-world shape observed from Qwen2.5-7B-Instruct: the parameter tag is
// emitted without a name (`<parameter>NAME</parameter>` followed by the value
// as plain text) instead of the canonical `<parameter=NAME>VALUE</parameter>`.
const NAMELESS_OUTPUT = `<tool_call>
<function=get_weather>
<parameter>city</parameter>
Seoul
<parameter>unit</parameter>
celsius
</function>
</tool_call>`;

const alarmTools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "set_alarm",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string" },
        days: {
          type: "array",
          items: {
            type: "string",
            enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          },
        },
        volume: { type: "number" },
        label: { type: ["string", "null"] },
      },
      required: ["time", "days", "volume"],
    },
  },
];

// Live DeepSeek V3.1 output: it uses a closed nameless parameter tag for the
// name, then wraps the following value with a second closing parameter tag.
const DEEPSEEK_NAME_THEN_VALUE_OUTPUT = `<tool_call>
<function=set_alarm>
<parameter>time</parameter>
07:30
</parameter>
<parameter>days</parameter>
["mon", "tue", "wed", "thu", "fri"]
</parameter>
<parameter>volume</parameter>
0.8
</parameter>
<parameter>label</parameter>
null
</parameter>
</function>
</tool_call>`;

const DEEPSEEK_NAME_THEN_VALUE_SPLITS = Array.from(
  { length: DEEPSEEK_NAME_THEN_VALUE_OUTPUT.length - 1 },
  (_, index) => index + 1
);

const expectedAlarmInput = {
  time: "07:30",
  days: ["mon", "tue", "wed", "thu", "fri"],
  volume: 0.8,
  // Nullable strings intentionally preserve the model's literal "null";
  // converting that spelling to null would be a separate coercion policy.
  label: "null",
};

function findToolCall(
  parts: readonly (LanguageModelV4Content | LanguageModelV4StreamPart)[]
) {
  const call = parts.find((part) => part.type === "tool-call");
  if (call?.type !== "tool-call") {
    throw new Error("Expected tool-call part");
  }
  return call;
}

function parseGenerated(text: string, tools: LanguageModelV4FunctionTool[]) {
  return runGeneratedJsonRepair({
    protocol: qwen3CoderProtocol(),
    text,
    tools,
  });
}

function streamText(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[],
  onError?: NonNullable<ParserOptions["onError"]>
) {
  return runProtocolTextStream({
    protocol: qwen3CoderProtocol(),
    tools,
    chunks,
    id: "fixture",
    parserOptions: onError === undefined ? undefined : { onError },
  });
}

function expectAlarmCall(parts: LanguageModelV4StreamPart[]): void {
  const call = findToolCall(parts);
  expect(
    selectToolInputTimeline(parts)
      .deltas.map((part) => part.delta)
      .join("")
  ).toBe(call.input);
  expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
}

function generatedCall(text: string, tools: LanguageModelV4FunctionTool[]) {
  return findToolCall(parseGenerated(text, tools));
}

function expectRedactedError(
  calls: readonly Parameters<NonNullable<ParserOptions["onError"]>>[],
  forbiddenText: string
): void {
  const errors = JSON.stringify(calls);
  expect(errors).toContain("[redacted sensitive tool call]");
  expect(errors).not.toContain(forbiddenText);
  expect(errors).not.toContain("<tool_call>");
}

describe("qwen3CoderProtocol nameless parameter salvage", () => {
  const tools = emptyFunctionTools;

  it("recovers <parameter>name</parameter>value pairs", () => {
    const call = findToolCall(parseGenerated(NAMELESS_OUTPUT, tools));
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("recovers DeepSeek name-then-value parameters with a redundant close tag", () => {
    const call = findToolCall(
      parseGenerated(DEEPSEEK_NAME_THEN_VALUE_OUTPUT, alarmTools)
    );
    expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
  });

  it.each(DEEPSEEK_NAME_THEN_VALUE_SPLITS)(
    "keeps DeepSeek name-then-value streaming deltas final-input consistent at split $split",
    async (split) => {
      const onError = vi.fn();
      const out = await streamText(
        [
          DEEPSEEK_NAME_THEN_VALUE_OUTPUT.slice(0, split),
          DEEPSEEK_NAME_THEN_VALUE_OUTPUT.slice(split),
        ],
        alarmTools,
        onError
      );

      const call = findToolCall(out);
      const { starts, ends, deltas } = selectToolInputTimeline(out);

      expect(onError, `split at ${split}`).not.toHaveBeenCalled();
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.id).toBe(call.toolCallId);
      expect(ends[0]?.id).toBe(call.toolCallId);
      expect(deltas.every((part) => part.id === call.toolCallId)).toBe(true);
      expect(deltas.map((part) => part.delta).join("")).toBe(call.input);
      expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
    }
  );

  it("keeps DeepSeek name-then-value parameters consistent one character at a time", async () => {
    const onError = vi.fn();
    const out = await streamText(
      [...DEEPSEEK_NAME_THEN_VALUE_OUTPUT],
      alarmTools,
      onError
    );

    expect(onError).not.toHaveBeenCalled();
    expectAlarmCall(out);
  });

  it("keeps DeepSeek name-then-value parameters consistent with raw events between every character", async () => {
    const onError = vi.fn();
    const parts = [
      ...DEEPSEEK_NAME_THEN_VALUE_OUTPUT,
    ].flatMap<LanguageModelV4StreamPart>((delta) => [
      {
        type: "raw",
        rawValue: { choices: [{ delta: { content: delta } }] },
      },
      { type: "text-delta", id: "deepseek-text", delta },
    ]);
    const out = await collectProtocolStream({
      protocol: qwen3CoderProtocol(),
      tools: alarmTools,
      parts: [
        ...parts,
        { type: "finish", finishReason: stopFinishReason, usage: zeroUsage },
      ],
      parserOptions: { onError },
    });

    expect(onError).not.toHaveBeenCalled();
    expectAlarmCall(out);
    expect(out.filter((part) => part.type === "raw")).toHaveLength(
      [...DEEPSEEK_NAME_THEN_VALUE_OUTPUT].length
    );
  });

  it("does not strip a nonterminal closing-tag literal from a schema string value", () => {
    const text = `<tool_call>
<function=set_alarm>
<parameter>time</parameter>
07:30 </parameter> literal
<parameter>days</parameter>
["mon", "tue", "wed", "thu", "fri"]
</parameter>
<parameter>volume</parameter>
0.8
</parameter>
</function>
</tool_call>`;
    const call = generatedCall(text, alarmTools);

    expect(JSON.parse(call.input)).toMatchObject({
      time: "07:30 </parameter> literal",
      days: ["mon", "tue", "wed", "thu", "fri"],
      volume: 0.8,
    });
  });

  it("preserves an escaped closing-tag literal while removing only the structural trailing close", () => {
    const text = `<tool_call>
<function=set_alarm>
<parameter>time</parameter>
07:30
</parameter>
<parameter>days</parameter>
["mon", "tue", "wed", "thu", "fri"]
</parameter>
<parameter>volume</parameter>
0.8
</parameter>
<parameter>label</parameter>
literal &lt;/parameter&gt;
</parameter>
</function>
</tool_call>`;

    expect(JSON.parse(generatedCall(text, alarmTools).input).label).toBe(
      "literal </parameter>"
    );
  });

  it("does not apply the redundant-close heuristic without a matching schema property", () => {
    const text = `<tool_call>
<function=get_weather>
<parameter>city</parameter>
Seoul
</parameter>
</function>
</tool_call>`;
    expect(JSON.parse(generatedCall(text, emptyFunctionTools).input)).toEqual({
      city: "Seoul\n</parameter>",
    });
  });

  it("recovers the nameless variant when streamed in small chunks", async () => {
    const out = await streamText([...NAMELESS_OUTPUT], tools);
    const call = findToolCall(out);
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("ignores nameless tags whose element text is not identifier-like", () => {
    const text =
      "<tool_call><function=get_weather><parameter>not a parameter name</parameter>value</function></tool_call>";
    const call = generatedCall(text, tools);
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({});
  });

  it("terminates a nameless value at the next parameter tag", () => {
    const text =
      "<tool_call><function=alpha><parameter>a</parameter>1<parameter=b>2</parameter></function></tool_call>";
    const call = generatedCall(text, tools);
    expect(JSON.parse(call.input)).toEqual({ a: "1", b: "2" });
  });

  it("trims surrounding whitespace from tool and parameter names", () => {
    const text =
      '<tool_call><function name=" get_weather "><parameter name=" city ">Seoul</parameter><parameter= unit >celsius</parameter></function></tool_call>';
    const call = generatedCall(text, tools);
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("ignores self-closing nameless parameter tags", async () => {
    const text =
      "<tool_call><function=get_weather><parameter/></function></tool_call>";
    const call = findToolCall(await streamText([...text], tools));
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({});
  });

  it("redacts raw fallback for prototype-sensitive nameless parameter keys", () => {
    const onError = vi.fn<NonNullable<ParserOptions["onError"]>>();
    const text =
      '<tool_call><function=get_weather><parameter>constructor</parameter>{"polluted":true}</function></tool_call>';

    const out = qwen3CoderProtocol().parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    const emittedText = out
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(emittedText).toBe("");
    expect(onError).toHaveBeenCalled();
    expectRedactedError(onError.mock.calls, "constructor");
  });

  it("redacts streaming raw fallback for prototype-sensitive nameless parameter keys", async () => {
    const onError = vi.fn<NonNullable<ParserOptions["onError"]>>();
    const text =
      '<tool_call><function=get_weather><parameter>constructor</parameter>{"polluted":true}</function></tool_call>';

    const out = await runProtocolTextStream({
      protocol: qwen3CoderProtocol(),
      tools,
      chunks: [...text],
      id: "fixture",
      parserOptions: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(collectTextDeltas(out)).toBe("");
    expect(onError).toHaveBeenCalled();
    expectRedactedError(onError.mock.calls, "constructor");
  });
});
