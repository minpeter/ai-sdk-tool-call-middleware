import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  createGlm5ToolResponseFormatter,
  formatToolResponseAsGlm5,
  GLM5_CHAT_TEMPLATE_REVISION,
  GLM5_CHAT_TEMPLATE_SHA256,
  glm5SystemPromptTemplate,
  renderGlm5ToolDefinition,
} from "../../../core/prompts/glm5-prompt";

const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get weather by city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      days: { type: "integer" },
    },
    required: ["city"],
  },
};

const pinnedChatTemplate = readFileSync(
  new URL("../../fixtures/glm5-chat-template.jinja", import.meta.url)
);

describe("GLM-5.2 official-template prompt", () => {
  it("pins the audited Hugging Face template revision and digest", () => {
    expect(GLM5_CHAT_TEMPLATE_REVISION).toBe(
      "b4734de4facf877f85769a911abafc5283eab3d9"
    );
    expect(GLM5_CHAT_TEMPLATE_SHA256).toBe(
      "172dc74a35e1752df75ecfb2b2cf9326d2852bb1379868ebeec9571654489679"
    );
    expect(createHash("sha256").update(pinnedChatTemplate).digest("hex")).toBe(
      GLM5_CHAT_TEMPLATE_SHA256
    );
  });

  it("checks in the exact official grammar and thinking gate as a golden artifact", () => {
    const source = pinnedChatTemplate.toString("utf8");

    expect(source).toContain(
      "<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value>"
    );
    expect(source).toContain(
      "<arg_value>{{ v | tojson(ensure_ascii=False) if v is not string else v }}</arg_value>"
    );
    expect(source).toContain(
      "'<think></think>' if (enable_thinking is defined and not enable_thinking) else '<think>'"
    );
  });

  it("renders the flattened function shape consumed by chat_template.jinja", () => {
    expect(JSON.parse(renderGlm5ToolDefinition(weatherTool))).toEqual({
      name: "get_weather",
      description: "Get weather by city",
      parameters: weatherTool.inputSchema,
    });
  });

  it("normalizes a serialized input schema without adding wrapper fields", () => {
    const tool = {
      ...weatherTool,
      inputSchema: JSON.stringify(weatherTool.inputSchema),
    } as unknown as LanguageModelV4FunctionTool;

    expect(JSON.parse(renderGlm5ToolDefinition(tool))).toEqual({
      name: "get_weather",
      description: "Get weather by city",
      parameters: weatherTool.inputSchema,
    });
  });

  it("matches the official tools block and call grammar", () => {
    const prompt = glm5SystemPromptTemplate([weatherTool]);

    expect(prompt).toContain("# Tools\n\nYou may call one or more functions");
    expect(prompt).toContain("<tools>\n");
    expect(prompt).toContain(renderGlm5ToolDefinition(weatherTool));
    expect(prompt).toContain("\n</tools>\n\nFor each function call");
    expect(prompt).toContain(
      "<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value>"
    );
    expect(prompt).not.toContain("<|system|>");
    expect(prompt).not.toContain("[gMASK]");
  });

  it("returns no synthetic system content when there are no tools", () => {
    expect(glm5SystemPromptTemplate([])).toBe("");
  });
});

describe("GLM-5.2 tool response formatting", () => {
  const result = {
    type: "tool-result",
    toolCallId: "tc-1",
    toolName: "get_weather",
    output: { type: "json", value: { temperature: 25 } },
  } satisfies ToolResultPart;

  it("uses the official observation payload wrapper", () => {
    expect(formatToolResponseAsGlm5(result)).toBe(
      '<tool_response>{"temperature":25}</tool_response>'
    );
  });

  it("provides an equivalent configurable formatter factory", () => {
    expect(createGlm5ToolResponseFormatter()(result)).toBe(
      formatToolResponseAsGlm5(result)
    );
  });
});
