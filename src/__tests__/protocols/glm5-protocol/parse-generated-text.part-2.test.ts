import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { glm5Protocol } from "../../../core/protocols/glm5-protocol";
import { glm5Tools, normalizeContentToolCalls, toolCallInput } from "./shared";

describe("parse-generated-text.test split 2", () => {
  it("rejects ambiguous generated-name digest and stem recovery", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "first_aaaaaaaaaaaa",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "second_aaaaaaaaaaaa",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "shared_bbbbbbbbbbbb",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "shared_cccccccccccc",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({
          text: [
            "<tool_call>unknown_aaaaaaaaaaaa</tool_call>",
            "<tool_call>shared</tool_call>",
            "<tool_call>shared_dddddddd</tool_call>",
          ].join(""),
          tools,
        })
      )
    ).toEqual([]);
  });

  it("recovers unique case and punctuation variants plus missing structural closes", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>GET_WEATHER",
        "<arg_key>USER_ID",
        "<arg_value>account-7</arg_value>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      {
        toolName: "get-weather",
        input: { "user-id": "account-7" },
      },
    ]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        toolName: "get-weather",
        recoveryCodes: expect.arrayContaining([
          "recovered-tool-name",
          "recovered-argument-key",
          "recovered-missing-arg-key-close",
          "recovered-missing-tool-call-close",
        ]),
      })
    );
  });

  it("recovers a final value and call whose close tags were truncated", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>echo<arg_key>message</arg_key><arg_value>still useful",
      tools: glm5Tools,
      options: { onError },
    });

    expect(toolCallInput(output)).toEqual({ message: "still useful" });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-missing-arg-value-close",
          "recovered-missing-tool-call-close",
        ]),
      })
    );
  });

  it("preserves bounded bare references for explicitly open object handles", () => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "validate_payload",
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
            size: { type: "integer" },
          },
          required: ["payload", "size"],
        },
      },
    ];
    const onError = vi.fn();
    const text = [
      "<tool_call>validate_payload",
      "<arg_key>payload</arg_key><arg_value>responseData</arg_value>",
      "<arg_key>size</arg_key><arg_value>5</arg_value>",
      "</tool_call>",
    ].join("");

    expect(
      toolCallInput(
        glm5Protocol().parseGeneratedText({
          text,
          tools,
          options: { onError },
        })
      )
    ).toEqual({ payload: "responseData", size: 5 });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining([
          "recovered-opaque-object-reference",
        ]),
      })
    );
    expect(
      normalizeContentToolCalls(
        glm5Protocol({
          recoverOpaqueObjectReferences: false,
        }).parseGeneratedText({ text, tools })
      )
    ).toEqual([]);
  });

  it.each([
    "responseData + injected",
    "responseData(arg)",
    "responseData;pollute()",
    "constructor.prototype",
    "__proto__",
  ])("rejects an unsafe opaque object expression: %s", (reference) => {
    const tools: LanguageModelV4FunctionTool[] = [
      {
        type: "function",
        name: "consume",
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "object", additionalProperties: true },
          },
          required: ["payload"],
        },
      },
    ];
    const text = `<tool_call>consume<arg_key>payload</arg_key><arg_value>${reference}</arg_value></tool_call>`;

    expect(
      normalizeContentToolCalls(
        glm5Protocol().parseGeneratedText({ text, tools })
      )
    ).toEqual([]);
  });

  it("drops unknown arguments without inventing a schema mapping", () => {
    const onError = vi.fn();
    const output = glm5Protocol().parseGeneratedText({
      text: [
        "<tool_call>get-weather",
        "<arg_key>city</arg_key><arg_value>Busan</arg_value>",
        "<arg_key>unrelated</arg_key><arg_value>ignore me</arg_value>",
        "</tool_call>",
      ].join(""),
      tools: glm5Tools,
      options: { onError },
    });

    expect(toolCallInput(output)).toEqual({ city: "Busan" });
    expect(onError).toHaveBeenCalledWith(
      "Recovered malformed GLM-5.2 tool call.",
      expect.objectContaining({
        recoveryCodes: expect.arrayContaining(["dropped-unknown-argument-key"]),
      })
    );
  });

  it("does not guess when punctuation-normalized tool names are ambiguous", () => {
    const onError = vi.fn();
    const ambiguousTools = glm5Tools.concat([
      {
        type: "function",
        name: "get_weather",
        description: "Ambiguous on purpose.",
        inputSchema: { type: "object" },
      },
    ]);
    const output = glm5Protocol().parseGeneratedText({
      text: "<tool_call>GetWeather</tool_call>",
      tools: ambiguousTools,
      options: { onError },
    });

    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      "Could not parse GLM-5.2 tool call.",
      expect.objectContaining({ dropReason: "malformed-glm5-tool-call" })
    );
  });

  it("keeps a canonical-looking call inside Markdown code as non-executable text", () => {
    const text = "Example only, do not execute: `<tool_call>ping</tool_call>`.";
    const protocol = glm5Protocol();

    const output = protocol.parseGeneratedText({ text, tools: glm5Tools });
    expect(normalizeContentToolCalls(output)).toEqual([]);
    expect(
      output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe(text);
    expect(
      protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
  });

  it.each([
    ["bare", "", ""],
    ["language-labeled", "xml", ""],
    ["bare with preceding fenced content", "", "example\n"],
    ["language-labeled with preceding fenced content", "xml", "example\n"],
  ])(
    "keeps a canonical call inside a %s fenced block non-executable",
    (_name, language, fencedPrefix) => {
      const text = `\`\`\`${language}\n${fencedPrefix}<tool_call>ping</tool_call>\n\`\`\``;
      const protocol = glm5Protocol();
      const output = protocol.parseGeneratedText({
        text,
        tools: glm5Tools,
      });

      expect(normalizeContentToolCalls(output)).toEqual([]);
      expect(
        output
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      ).toBe(text);
      expect(
        protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
      ).toEqual([]);
    }
  );

  it("executes calls after a balanced Markdown code span even when the closing backtick is adjacent", () => {
    const text = "Use `CellResult`<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
    expect(
      output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("Use `CellResult`");
  });

  it("does not let an unbalanced prose backtick swallow a later canonical call", () => {
    const text =
      "Repository `https://example.test/repo%60 from `/home/user` right away.<tool_call>ping</tool_call>";
    const output = glm5Protocol().parseGeneratedText({
      text,
      tools: glm5Tools,
    });

    expect(normalizeContentToolCalls(output)).toEqual([
      { toolName: "ping", input: {} },
    ]);
  });

  it("rejects a nested complete call that names a declared tool", () => {
    const text =
      "<tool_call>echo<arg_key>message</arg_key><arg_value>outer <tool_call>ping</tool_call></arg_value></tool_call>";
    const protocol = glm5Protocol();

    expect(
      normalizeContentToolCalls(
        protocol.parseGeneratedText({ text, tools: glm5Tools })
      )
    ).toEqual([]);
    expect(
      protocol.extractToolCallSegments?.({ text, tools: glm5Tools })
    ).toEqual([]);
  });
});
