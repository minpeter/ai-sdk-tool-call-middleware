import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { yamlXmlSystemPromptTemplate } from "../../../core/prompts/yaml-xml-prompt";

describe("yamlXmlSystemPromptTemplate", () => {
  it("renders Input Examples from tool.inputExamples", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            unit: { type: "string" },
          },
          required: ["city"],
        },
        inputExamples: [
          {
            input: {
              city: "Seoul",
              unit: "celsius",
            },
          },
        ],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ]);

    expect(prompt).toContain("# Input Examples");
    expect(prompt).toContain("Tool: get_weather");
    expect(prompt).toContain("<get_weather>");
    expect(prompt).toContain("city: Seoul");
    expect(prompt).toContain("unit: celsius");
  });

  it("escapes XML special characters in YAML input examples", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      {
        type: "function",
        name: "write_file",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
        },
        inputExamples: [{ input: { content: "<tag> & value" } }],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ]);

    expect(prompt).toContain("&lt;tag> &amp; value");
  });

  it("falls back safely when YAML stringify throws", () => {
    const spy = vi.spyOn(YAML, "stringify").mockImplementation(() => {
      throw new Error("boom");
    });

    try {
      const prompt = yamlXmlSystemPromptTemplate([
        {
          type: "function",
          name: "write_file",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
            required: ["content"],
          },
          inputExamples: [{ input: { content: "x" } }],
        } satisfies LanguageModelV3FunctionTool & {
          inputExamples: Array<{ input: unknown }>;
        },
      ]);

      expect(prompt).toContain('{"content":"x"}');
    } finally {
      spy.mockRestore();
    }
  });

  it("uses safe fallback tag when tool name is not a valid XML tag", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      {
        type: "function",
        name: "1invalid_name",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
          required: ["value"],
        },
        inputExamples: [{ input: { value: "ok" } }],
      } satisfies LanguageModelV3FunctionTool & {
        inputExamples: Array<{ input: unknown }>;
      },
    ]);

    expect(prompt).toContain("<tool>");
    expect(prompt).toContain("</tool>");
    expect(prompt).not.toContain("<1invalid_name>");
  });
});
