import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { yamlXmlSystemPromptTemplate } from "../../../core/prompts/yaml-xml-prompt";
import {
  stringInputExampleTool,
  weatherInputExampleTool,
} from "./shared/prompt-duplicate-fixtures";

describe("yamlXmlSystemPromptTemplate", () => {
  it("renders Input Examples from tool.inputExamples", () => {
    const prompt = yamlXmlSystemPromptTemplate([weatherInputExampleTool]);

    expect(prompt).toContain("# Input Examples");
    expect(prompt).toContain("Tool: get_weather");
    expect(prompt).toContain("<get_weather>");
    expect(prompt).toContain("city: Seoul");
    expect(prompt).toContain("unit: celsius");
  });

  it("escapes XML special characters in YAML input examples", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      stringInputExampleTool("write_file", "content", "<tag> & value"),
    ]);

    expect(prompt).toContain("&lt;tag> &amp; value");
  });

  it("falls back safely when YAML stringify throws", () => {
    const spy = vi.spyOn(YAML, "stringify").mockImplementation(() => {
      throw new Error("boom");
    });

    try {
      const prompt = yamlXmlSystemPromptTemplate([
        stringInputExampleTool("write_file", "content", "x"),
      ]);

      expect(prompt).toContain('{"content":"x"}');
    } finally {
      spy.mockRestore();
    }
  });

  it("uses safe fallback tag when tool name is not a valid XML tag", () => {
    const prompt = yamlXmlSystemPromptTemplate([
      stringInputExampleTool("1invalid_name", "value", "ok"),
    ]);

    expect(prompt).toContain("<tool>");
    expect(prompt).toContain("</tool>");
    expect(prompt).not.toContain("<1invalid_name>");
  });
});
