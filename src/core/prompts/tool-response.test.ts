import type { ToolResultPart } from "@ai-sdk/provider-utils";
import { describe, expect, it } from "vitest";
import {
  formatToolResponseAsJsonInXml,
  formatToolResponseAsXml,
  unwrapToolResult,
} from "./tool-response";

/**
 * Test suite for tool-response.ts
 *
 * Tests cover all 6 AI SDK ToolResultOutput types:
 * - text: { type: 'text', value: string }
 * - json: { type: 'json', value: JSONValue }
 * - execution-denied: { type: 'execution-denied', reason?: string }
 * - error-text: { type: 'error-text', value: string }
 * - error-json: { type: 'error-json', value: JSONValue }
 * - content: { type: 'content', value: ContentPart[] }
 */

describe("tool-response", () => {
  describe("unwrapToolResult", () => {
    describe("ToolResultOutput: text type", () => {
      it("extracts value from text type", () => {
        expect(unwrapToolResult({ type: "text", value: "hello world" })).toBe(
          "hello world"
        );
      });

      it("handles empty string value", () => {
        expect(unwrapToolResult({ type: "text", value: "" })).toBe("");
      });

      it("ignores providerOptions", () => {
        expect(
          unwrapToolResult({
            type: "text",
            value: "test",
            providerOptions: { custom: { enabled: true } },
          })
        ).toBe("test");
      });
    });

    describe("ToolResultOutput: json type", () => {
      it("extracts value from json type (object)", () => {
        expect(
          unwrapToolResult({ type: "json", value: { data: 123 } })
        ).toEqual({ data: 123 });
      });

      it("extracts value from json type (array)", () => {
        expect(unwrapToolResult({ type: "json", value: [1, 2, 3] })).toEqual([
          1, 2, 3,
        ]);
      });

      it("extracts value from json type (primitive string)", () => {
        expect(unwrapToolResult({ type: "json", value: "string" })).toBe(
          "string"
        );
      });

      it("extracts value from json type (primitive number)", () => {
        expect(unwrapToolResult({ type: "json", value: 42 })).toBe(42);
      });

      it("extracts null value from json type", () => {
        expect(unwrapToolResult({ type: "json", value: null })).toBe(null);
      });

      it("extracts boolean value from json type", () => {
        expect(unwrapToolResult({ type: "json", value: true })).toBe(true);
        expect(unwrapToolResult({ type: "json", value: false })).toBe(false);
      });
    });

    describe("ToolResultOutput: execution-denied type", () => {
      it("formats execution-denied with reason", () => {
        const result = unwrapToolResult({
          type: "execution-denied",
          reason: "User declined permission",
        });
        expect(result).toBe("[Execution Denied: User declined permission]");
      });

      it("formats execution-denied without reason", () => {
        const result = unwrapToolResult({ type: "execution-denied" });
        expect(result).toBe("[Execution Denied]");
      });
    });

    describe("ToolResultOutput: error-text type", () => {
      it("formats error-text as error message", () => {
        const result = unwrapToolResult({
          type: "error-text",
          value: "Something went wrong",
        });
        expect(result).toBe("[Error: Something went wrong]");
      });

      it("handles empty error message", () => {
        const result = unwrapToolResult({
          type: "error-text",
          value: "",
        });
        expect(result).toBe("[Error: ]");
      });
    });

    describe("ToolResultOutput: error-json type", () => {
      it("formats error-json as stringified error", () => {
        const result = unwrapToolResult({
          type: "error-json",
          value: { code: 500, message: "Server error" },
        });
        expect(result).toBe('[Error: {"code":500,"message":"Server error"}]');
      });

      it("handles null error value", () => {
        const result = unwrapToolResult({
          type: "error-json",
          value: null,
        });
        expect(result).toBe("[Error: null]");
      });
    });

    describe("ToolResultOutput: content type - text parts", () => {
      it("extracts single text part", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "text", text: "hello" }],
          })
        ).toBe("hello");
      });

      it("joins multiple text parts with newlines", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          })
        ).toBe("line 1\nline 2");
      });

      it("handles empty content array", () => {
        expect(unwrapToolResult({ type: "content", value: [] })).toBe("");
      });
    });

    describe("ToolResultOutput: content type - image parts (unsupported)", () => {
      it("replaces image-data with placeholder", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              { type: "image-data", data: "base64...", mediaType: "image/png" },
            ],
          })
        ).toBe("[Image: image/png]");
      });

      it("includes image-url as reference", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "image-url", url: "https://example.com/img.png" }],
          })
        ).toBe("[Image URL: https://example.com/img.png]");
      });

      it("replaces image-file-id with placeholder (string)", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "image-file-id", fileId: "img-abc123" }],
          })
        ).toBe("[Image ID: img-abc123]");
      });

      it("replaces image-file-id with placeholder (object)", () => {
        const result = unwrapToolResult({
          type: "content",
          value: [{ type: "image-file-id", fileId: { openai: "file-123" } }],
        });
        expect(result).toContain("[Image ID:");
        expect(result).toContain("openai");
      });
    });

    describe("ToolResultOutput: content type - file parts (unsupported)", () => {
      it("replaces file-data with placeholder including filename", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              {
                type: "file-data",
                data: "base64...",
                mediaType: "application/pdf",
                filename: "report.pdf",
              },
            ],
          })
        ).toBe("[File: report.pdf (application/pdf)]");
      });

      it("replaces file-data without filename", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              {
                type: "file-data",
                data: "base64...",
                mediaType: "application/pdf",
              },
            ],
          })
        ).toBe("[File: application/pdf]");
      });

      it("includes file-url as reference", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "file-url", url: "https://example.com/doc.pdf" }],
          })
        ).toBe("[File URL: https://example.com/doc.pdf]");
      });

      it("replaces file-id with placeholder (string)", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "file-id", fileId: "file-abc123" }],
          })
        ).toBe("[File ID: file-abc123]");
      });

      it("replaces file-id with placeholder (object)", () => {
        const result = unwrapToolResult({
          type: "content",
          value: [{ type: "file-id", fileId: { openai: "file-123" } }],
        });
        expect(result).toContain("[File ID:");
      });
    });

    describe("ToolResultOutput: content type - other parts", () => {
      it("replaces deprecated media type with placeholder", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              { type: "media", data: "base64...", mediaType: "audio/mp3" },
            ],
          })
        ).toBe("[Media: audio/mp3]");
      });

      it("replaces custom type with placeholder", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              { type: "custom", providerOptions: { foo: { bar: "baz" } } },
            ],
          })
        ).toBe("[Custom content]");
      });

      it("handles unknown content part type gracefully", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [{ type: "unknown-future-type" } as any],
          })
        ).toBe("[Unknown content]");
      });
    });

    describe("ToolResultOutput: content type - mixed parts", () => {
      it("combines text with placeholders for unsupported", () => {
        expect(
          unwrapToolResult({
            type: "content",
            value: [
              { type: "text", text: "Here is the image:" },
              { type: "image-url", url: "https://example.com/chart.png" },
              { type: "text", text: "Analysis complete." },
            ],
          })
        ).toBe(
          "Here is the image:\n[Image URL: https://example.com/chart.png]\nAnalysis complete."
        );
      });

      it("handles complex mixed content", () => {
        const result = unwrapToolResult({
          type: "content",
          value: [
            { type: "text", text: "Files attached:" },
            {
              type: "file-data",
              data: "...",
              mediaType: "text/csv",
              filename: "data.csv",
            },
            { type: "image-data", data: "...", mediaType: "image/jpeg" },
            { type: "text", text: "End of results" },
          ],
        });
        expect(result).toBe(
          "Files attached:\n[File: data.csv (text/csv)]\n[Image: image/jpeg]\nEnd of results"
        );
      });
    });
  });

  describe("formatToolResponseAsJsonInXml", () => {
    it("formats basic tool result", () => {
      const toolResult: ToolResultPart = {
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get_weather",
        output: { type: "json", value: { temp: 25 } },
      };
      const result = formatToolResponseAsJsonInXml(toolResult);
      expect(result).toContain("<tool_response>");
      expect(result).toContain("</tool_response>");
      expect(result).toContain('"toolName":"get_weather"');
      expect(result).toContain('"result":{"temp":25}');
    });

    it("unwraps json-typed result before formatting", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get_weather",
        output: { type: "json", value: { temp: 25 } },
      } satisfies ToolResultPart);
      expect(result).toContain('"result":{"temp":25}');
      expect(result).not.toContain('"type":"json"');
    });

    it("unwraps text-typed result before formatting", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "echo",
        output: { type: "text", value: "hello world" },
      } satisfies ToolResultPart);
      expect(result).toContain('"result":"hello world"');
    });

    it("handles execution-denied result", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "delete_file",
        output: { type: "execution-denied", reason: "Permission denied" },
      } satisfies ToolResultPart);
      expect(result).toContain("Execution Denied");
      expect(result).toContain("Permission denied");
    });

    it("handles error-text result", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "fetch_data",
        output: { type: "error-text", value: "Network timeout" },
      } satisfies ToolResultPart);
      expect(result).toContain("Error");
      expect(result).toContain("Network timeout");
    });

    it("handles content type with images", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "screenshot",
        output: {
          type: "content",
          value: [
            { type: "text", text: "Screenshot captured" },
            { type: "image-data", data: "base64...", mediaType: "image/png" },
          ],
        },
      } satisfies ToolResultPart);
      expect(result).toContain("Screenshot captured");
      expect(result).toContain("[Image: image/png]");
    });

    it("handles string output", () => {
      const result = formatToolResponseAsJsonInXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "echo",
        output: { type: "text", value: "simple string" },
      } satisfies ToolResultPart);
      expect(result).toContain('"result":"simple string"');
    });
  });

  describe("formatToolResponseAsXml", () => {
    it("formats basic tool result with XML tags", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "search",
        output: { type: "text", value: "found results" },
      } satisfies ToolResultPart);
      expect(result).toBe(
        [
          "<tool_response>",
          "  <tool_name>search</tool_name>",
          "  <result>found results</result>",
          "</tool_response>",
        ].join("\n")
      );
    });

    it("formats full XML response with nested result", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get_weather",
        output: {
          type: "json",
          value: {
            city: "New York",
            temperature: 47,
            condition: "sunny",
          },
        },
      } satisfies ToolResultPart);
      expect(result).toBe(
        [
          "<tool_response>",
          "  <tool_name>get_weather</tool_name>",
          "  <result>",
          "    <city>New York</city>",
          "    <temperature>47</temperature>",
          "    <condition>sunny</condition>",
          "  </result>",
          "</tool_response>",
        ].join("\n")
      );
    });

    it("does not escape XML special characters in tool name", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get<data>",
        output: { type: "text", value: "test" },
      } satisfies ToolResultPart);
      expect(result).toContain("<tool_name>get<data></tool_name>");
    });

    it("does not escape XML special characters in result", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "search",
        output: {
          type: "text",
          value: 'Results for <query> with "quotes" & ampersand',
        },
      } satisfies ToolResultPart);
      expect(result).toContain(
        '<result>Results for <query> with "quotes" & ampersand</result>'
      );
    });

    it("unwraps json-typed result before formatting", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get_data",
        output: { type: "json", value: { key: "value" } },
      } satisfies ToolResultPart);
      expect(result).toContain("<key>value</key>");
      expect(result).not.toContain('"type":"json"');
    });

    it("handles content type with images gracefully", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "screenshot",
        output: {
          type: "content",
          value: [
            { type: "text", text: "Screenshot captured" },
            { type: "image-data", data: "base64...", mediaType: "image/png" },
          ],
        },
      } satisfies ToolResultPart);
      expect(result).toContain("Screenshot captured");
      expect(result).toContain("[Image: image/png]");
    });

    it("formats object result as XML", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "get_data",
        output: { type: "json", value: { nested: { data: true } } },
      } satisfies ToolResultPart);
      expect(result).toContain("<nested>");
      expect(result).toContain("<data>true</data>");
      expect(result).toContain("</nested>");
    });

    it("handles execution-denied result", () => {
      const result = formatToolResponseAsXml({
        type: "tool-result",
        toolCallId: "tc1",
        toolName: "delete",
        output: { type: "execution-denied", reason: "Not authorized" },
      } satisfies ToolResultPart);
      expect(result).toContain("Execution Denied");
      expect(result).toContain("Not authorized");
    });
  });
});
