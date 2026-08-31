import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { glm5Tools } from "./shared";

const echoCall =
  "<tool_call>echo<arg_key>message</arg_key><arg_value>hello</arg_value></tool_call>";

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

    expect(
      glm5Protocol().extractToolCallSegments({ text, tools: glm5Tools })
    ).toEqual([echoCall]);
  });

  it("recovers one terminal incomplete call", () => {
    const text = "<tool_call>echo<arg_key>message</arg_key><arg_value>hello";

    expect(
      glm5Protocol().extractToolCallSegments({ text, tools: glm5Tools })
    ).toEqual([text]);
  });

  it("rejects nested incomplete calls instead of recovering an outer prefix", () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>bad<tool_call>ping";

    expect(
      glm5Protocol().extractToolCallSegments({ text, tools: glm5Tools })
    ).toEqual([]);
  });

  it("extracts an anchored bare function call", () => {
    const text = '  echo(message="hello")  ';

    expect(
      glm5Protocol().extractToolCallSegments({ text, tools: glm5Tools })
    ).toEqual(['echo(message="hello")']);
  });
});
