import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("XML Protocol Heuristic Parsing", () => {
  const protocol = morphXmlProtocol();

  describe("Edge cases and safety", () => {
    it("should handle text content with #text property", () => {
      const text = `<get_content>
        <message>Hello World</message>
      </get_content>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "get_content",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.message).toBe("Hello World");
      }
    });

    it("should preserve whitespace correctly", () => {
      const text = `<format_text>
        <values>
          <item>  spaced text  </item>
          <item>another  item</item>
        </values>
      </format_text>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "format_text",
          inputSchema: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toEqual(["spaced text", "another  item"]);
      }
    });

    it("should not process empty arrays", () => {
      const text = `<empty_data>
        <values></values>
      </empty_data>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "empty_data",
          inputSchema: {
            type: "object",
            properties: {
              values: { type: "string" },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.values).toBe("");
      }
    });

    it("should handle mixed content types", () => {
      const text = `<mixed_content>
        <data>
          <item>123</item>
          <item>hello</item>
          <item>45.67</item>
          <item>true</item>
        </data>
      </mixed_content>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "mixed_content",
          inputSchema: {
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");

      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.data).toEqual(["123", "hello", "45.67", "true"]);
      }
    });

    it("preserves nested object structure when no #text and no array/tuple heuristics apply (parse mode)", () => {
      const text = `<config>
        <settings>
          <theme>
            <dark>true</dark>
          </theme>
        </settings>
      </config>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "config",
          inputSchema: {
            type: "object",
            properties: { settings: { type: "object" } },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(typeof input.settings).toBe("object");
        expect(input.settings.theme.dark).toBe("true");
      }
    });

    it("maps arrays of objects with #text to trimmed values when prop is array of strings (parse mode)", () => {
      const text = `<tags>
        <labels>
          <item kind="s">  a  </item>
          <item kind="s">b</item>
        </labels>
      </tags>`;

      const tools: LanguageModelV3FunctionTool[] = [
        {
          type: "function",
          name: "tags",
          inputSchema: {
            type: "object",
            properties: {
              labels: { type: "array", items: { type: "string" } },
            },
          },
        },
      ];

      const result = protocol.parseGeneratedText({ text, tools });
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.labels).toEqual(["a", "b"]);
      }
    });
  });
});
