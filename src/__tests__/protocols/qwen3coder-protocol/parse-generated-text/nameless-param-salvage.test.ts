import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

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
