import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";
import { createInterleavedStream } from "../../cross-protocol/tool-input/streaming-events.shared";

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

const expectedAlarmInput = {
  time: "07:30",
  days: ["mon", "tue", "wed", "thu", "fri"],
  volume: 0.8,
  // Nullable strings intentionally preserve the model's literal "null";
  // converting that spelling to null would be a separate coercion policy.
  label: "null",
};

function findToolCall(parts: LanguageModelV4StreamPart[]) {
  const call = parts.find((part) => part.type === "tool-call");
  if (call?.type !== "tool-call") {
    throw new Error("Expected tool-call part");
  }
  return call;
}

describe("qwen3CoderProtocol nameless parameter salvage", () => {
  const tools = emptyFunctionTools;

  it("recovers <parameter>name</parameter>value pairs", () => {
    const p = qwen3CoderProtocol();
    const out = p.parseGeneratedText({ text: NAMELESS_OUTPUT, tools });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("recovers DeepSeek name-then-value parameters with a redundant close tag", () => {
    const p = qwen3CoderProtocol();
    const out = p.parseGeneratedText({
      text: DEEPSEEK_NAME_THEN_VALUE_OUTPUT,
      tools: alarmTools,
    });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
  });

  it("keeps DeepSeek name-then-value streaming deltas final-input consistent at every split", async () => {
    const p = qwen3CoderProtocol();

    for (
      let split = 1;
      split < DEEPSEEK_NAME_THEN_VALUE_OUTPUT.length;
      split += 1
    ) {
      const onError = vi.fn();
      const out = await convertReadableStreamToArray(
        pipeWithTransformer(
          createChunkedStream([
            DEEPSEEK_NAME_THEN_VALUE_OUTPUT.slice(0, split),
            DEEPSEEK_NAME_THEN_VALUE_OUTPUT.slice(split),
          ]),
          p.createStreamParser({
            tools: alarmTools,
            options: { onError },
          })
        )
      );

      const call = findToolCall(out);
      const starts = out.filter((part) => part.type === "tool-input-start");
      const ends = out.filter((part) => part.type === "tool-input-end");
      const deltas = out.filter((part) => part.type === "tool-input-delta");

      expect(onError, `split at ${split}`).not.toHaveBeenCalled();
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.id).toBe(call.toolCallId);
      expect(ends[0]?.id).toBe(call.toolCallId);
      expect(deltas.every((part) => part.id === call.toolCallId)).toBe(true);
      expect(deltas.map((part) => part.delta).join("")).toBe(call.input);
      expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
    }
  });

  it("keeps DeepSeek name-then-value parameters consistent one character at a time", async () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(DEEPSEEK_NAME_THEN_VALUE_OUTPUT),
        p.createStreamParser({
          tools: alarmTools,
          options: { onError },
        })
      )
    );

    const call = findToolCall(out);
    const deltas = out.filter((part) => part.type === "tool-input-delta");
    expect(onError).not.toHaveBeenCalled();
    expect(deltas.map((part) => part.delta).join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
  });

  it("keeps DeepSeek name-then-value parameters consistent with raw events between every character", async () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const parts = [
      ...DEEPSEEK_NAME_THEN_VALUE_OUTPUT,
    ].flatMap<LanguageModelV4StreamPart>((delta) => [
      {
        type: "raw",
        rawValue: { choices: [{ delta: { content: delta } }] },
      },
      { type: "text-delta", id: "deepseek-text", delta },
    ]);
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createInterleavedStream(parts),
        p.createStreamParser({
          tools: alarmTools,
          options: { onError },
        })
      )
    );

    const call = findToolCall(out);
    const deltas = out.filter((part) => part.type === "tool-input-delta");
    expect(onError).not.toHaveBeenCalled();
    expect(deltas.map((part) => part.delta).join("")).toBe(call.input);
    expect(JSON.parse(call.input)).toEqual(expectedAlarmInput);
    expect(out.filter((part) => part.type === "raw")).toHaveLength(
      [...DEEPSEEK_NAME_THEN_VALUE_OUTPUT].length
    );
  });

  it("does not strip a nonterminal closing-tag literal from a schema string value", () => {
    const p = qwen3CoderProtocol();
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
    const out = p.parseGeneratedText({ text, tools: alarmTools });
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(JSON.parse(call.input)).toMatchObject({
      time: "07:30 </parameter> literal",
      days: ["mon", "tue", "wed", "thu", "fri"],
      volume: 0.8,
    });
  });

  it("preserves an escaped closing-tag literal while removing only the structural trailing close", () => {
    const p = qwen3CoderProtocol();
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
    const out = p.parseGeneratedText({ text, tools: alarmTools });
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(JSON.parse(call.input).label).toBe("literal </parameter>");
  });

  it("does not apply the redundant-close heuristic without a matching schema property", () => {
    const p = qwen3CoderProtocol();
    const text = `<tool_call>
<function=get_weather>
<parameter>city</parameter>
Seoul
</parameter>
</function>
</tool_call>`;
    const out = p.parseGeneratedText({ text, tools: emptyFunctionTools });
    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }

    expect(JSON.parse(call.input)).toEqual({ city: "Seoul\n</parameter>" });
  });

  it("recovers the nameless variant when streamed in small chunks", async () => {
    const p = qwen3CoderProtocol();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(NAMELESS_OUTPUT),
        p.createStreamParser({ tools })
      )
    );

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("ignores nameless tags whose element text is not identifier-like", () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=get_weather><parameter>not a parameter name</parameter>value</function></tool_call>";
    const out = p.parseGeneratedText({ text, tools });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({});
  });

  it("terminates a nameless value at the next parameter tag", () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=alpha><parameter>a</parameter>1<parameter=b>2</parameter></function></tool_call>";
    const out = p.parseGeneratedText({ text, tools });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(JSON.parse(call.input)).toEqual({ a: "1", b: "2" });
  });

  it("trims surrounding whitespace from tool and parameter names", () => {
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function name=" get_weather "><parameter name=" city ">Seoul</parameter><parameter= unit >celsius</parameter></function></tool_call>';
    const out = p.parseGeneratedText({ text, tools });

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({
      city: "Seoul",
      unit: "celsius",
    });
  });

  it("ignores self-closing nameless parameter tags", async () => {
    const p = qwen3CoderProtocol();
    const text =
      "<tool_call><function=get_weather><parameter/></function></tool_call>";
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(text),
        p.createStreamParser({ tools })
      )
    );

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("get_weather");
    expect(JSON.parse(call.input)).toEqual({});
  });

  it("redacts raw fallback for prototype-sensitive nameless parameter keys", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=get_weather><parameter>constructor</parameter>{"polluted":true}</function></tool_call>';

    const out = p.parseGeneratedText({
      text,
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("<tool_call>");
  });

  it("redacts streaming raw fallback for prototype-sensitive nameless parameter keys", async () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const text =
      '<tool_call><function=get_weather><parameter>constructor</parameter>{"polluted":true}</function></tool_call>';

    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(text),
        p.createStreamParser({
          tools,
          options: { emitRawToolCallTextOnError: true, onError },
        })
      )
    );

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => (part as { delta: string }).delta)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalled();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("<tool_call>");
  });
});
