import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { toolCallInput } from "./shared";

describe("parse-generated-text.test split 4", () => {
  it("accepts additionalProperties and patternProperties keys", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "dynamic",
        inputSchema: {
          type: "object",
          properties: { fixed: { type: "string" } },
          patternProperties: { "^count_": { type: "integer" } },
          additionalProperties: { type: "boolean" },
        },
      },
    ];
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>dynamic",
        "<arg_key>fixed</arg_key><arg_value>ok</arg_value>",
        "<arg_key>count_a</arg_key><arg_value>3</arg_value>",
        "<arg_key>enabled</arg_key><arg_value>true</arg_value>",
        "</tool_call>",
      ].join(""),
      tools,
    });

    expect(toolCallInput(output)).toEqual({
      fixed: "ok",
      count_a: 3,
      enabled: true,
    });
  });
});
