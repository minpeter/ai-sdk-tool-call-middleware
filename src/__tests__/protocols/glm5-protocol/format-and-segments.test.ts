import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { glm5Tools } from "./shared";

const echoCall =
  "<tool_call>echo<arg_key>message</arg_key><arg_value>hello</arg_value></tool_call>";

function extractSegments(text: string): string[] {
  const extract = glm5Protocol().extractToolCallSegments;
  if (!extract) {
    throw new Error("GLM-5 protocol must expose segment extraction");
  }
  return extract({ text, tools: glm5Tools });
}

describe("GLM-5 protocol formatting", () => {
  it("formats string, numeric, boolean, and null arguments", () => {
    expect(
      glm5Protocol().formatToolCall({
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "echo",
        input: JSON.stringify({
          message: "hello",
          count: 2,
          enabled: true,
          empty: null,
        }),
      })
    ).toBe(
      "<tool_call>echo" +
        "<arg_key>message</arg_key><arg_value>hello</arg_value>" +
        "<arg_key>count</arg_key><arg_value>2</arg_value>" +
        "<arg_key>enabled</arg_key><arg_value>true</arg_value>" +
        "<arg_key>empty</arg_key><arg_value>null</arg_value>" +
        "</tool_call>"
    );
  });

  it.each(["not-json", "null", "[]"])(
    "omits arguments when input is not an object: %s",
    (input) => {
      expect(
        glm5Protocol().formatToolCall({
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "echo",
          input,
        })
      ).toBe("<tool_call>echo</tool_call>");
    }
  );
});

describe("GLM-5 protocol segment extraction", () => {
  it("extracts closed calls and ignores calls inside fenced code", () => {
    const text = ["```", echoCall, "```", "Use this call:", echoCall].join(
      "\n"
    );

    expect(extractSegments(text)).toEqual([echoCall]);
  });

  it("ignores one incomplete call that begins directly inside fenced code", () => {
    const text = "```\n<tool_call>echo";

    expect(extractSegments(text)).toEqual([]);
  });

  it("recovers one terminal incomplete call", () => {
    const text = "<tool_call>echo<arg_key>message</arg_key><arg_value>hello";

    expect(extractSegments(text)).toEqual([text]);
  });

  it("rejects nested incomplete calls instead of recovering an outer prefix", () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>bad<tool_call>ping";

    expect(extractSegments(text)).toEqual([]);
  });

  it("extracts an anchored bare function call", () => {
    const text = '  echo(message="hello")  ';

    expect(extractSegments(text)).toEqual(['echo(message="hello")']);
  });
});

describe("GLM-5 generated-text failure handling", () => {
  it("reports and preserves a safe nested incomplete call when requested", () => {
    const onError = vi.fn();
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>bad<tool_call>ping";

    expect(
      glm5Protocol().parseGeneratedText({
        text,
        tools: glm5Tools,
        options: { emitRawToolCallTextOnError: true, onError },
      })
    ).toEqual([{ type: "text", text }]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it("preserves a safe incomplete call when recovery is disabled", () => {
    const onError = vi.fn();
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>unfinished";

    expect(
      glm5Protocol({ recoverIncompleteToolCalls: false }).parseGeneratedText({
        text,
        tools: glm5Tools,
        options: { emitRawToolCallTextOnError: true, onError },
      })
    ).toEqual([{ type: "text", text }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a structurally closed call for an unknown tool", () => {
    const onError = vi.fn();
    const text = "<tool_call>unknown</tool_call>";

    expect(
      glm5Protocol().parseGeneratedText({
        text,
        tools: glm5Tools,
        options: { emitRawToolCallTextOnError: true, onError },
      })
    ).toEqual([{ type: "text", text }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports an unrecoverable terminal call body", () => {
    const onError = vi.fn();
    const text = "<tool_call>%%%";

    expect(
      glm5Protocol().parseGeneratedText({
        text,
        tools: glm5Tools,
        options: { emitRawToolCallTextOnError: true, onError },
      })
    ).toEqual([{ type: "text", text }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
