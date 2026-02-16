import { describe, expect, it } from "vitest";
import {
  normalizeToolResultForUserContent,
  unwrapToolResult,
} from "./tool-result-normalizer";

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
      expect(unwrapToolResult({ type: "json", value: { data: 123 } })).toEqual({
        data: 123,
      });
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
          value: [{ type: "media", data: "base64...", mediaType: "audio/mp3" }],
        })
      ).toBe("[Media: audio/mp3]");
    });

    it("replaces custom type with placeholder", () => {
      expect(
        unwrapToolResult({
          type: "content",
          value: [{ type: "custom", providerOptions: { foo: { bar: "baz" } } }],
        })
      ).toBe("[Custom content]");
    });

    it("handles unknown content part type gracefully", () => {
      expect(
        unwrapToolResult({
          type: "content",
          value: [
            {
              type: "unknown-future-type",
            } as never,
          ],
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

    it("returns raw content when media strategy is raw", () => {
      const result = unwrapToolResult(
        {
          type: "content",
          value: [
            { type: "text", text: "visual" },
            {
              type: "image-data",
              data: "base64...",
              mediaType: "image/png",
            },
          ],
        },
        {
          mode: "raw",
        }
      );

      expect(result).toEqual([
        { type: "text", text: "visual" },
        {
          type: "image-data",
          data: "base64...",
          mediaType: "image/png",
        },
      ]);
    });

    it("returns raw content in auto mode when media capability is enabled", () => {
      const result = unwrapToolResult(
        {
          type: "content",
          value: [
            {
              type: "file-data",
              data: "abc",
              mediaType: "audio/mp3",
              filename: "sample.mp3",
            },
          ],
        },
        {
          mode: "auto",
          capabilities: {
            audio: true,
          },
        }
      );

      expect(result).toEqual([
        {
          type: "file-data",
          data: "abc",
          mediaType: "audio/mp3",
          filename: "sample.mp3",
        },
      ]);
    });

    it("falls back to placeholders in auto mode when media capability is disabled", () => {
      const result = unwrapToolResult(
        {
          type: "content",
          value: [
            {
              type: "file-data",
              data: "abc",
              mediaType: "video/mp4",
              filename: "clip.mp4",
            },
          ],
        },
        {
          mode: "auto",
          capabilities: {
            video: false,
          },
        }
      );

      expect(result).toBe("[File: clip.mp4 (video/mp4)]");
    });
  });
});

describe("normalizeToolResultForUserContent", () => {
  it("converts image-url content into model-recognizable file part in model mode", () => {
    const result = normalizeToolResultForUserContent(
      {
        type: "content",
        value: [{ type: "image-url", url: "https://example.com/a.png" }],
      },
      {
        mode: "model",
      }
    );

    expect(result).toEqual([
      {
        type: "file",
        data: "https://example.com/a.png",
        mediaType: "image/*",
      },
    ]);
  });

  it("converts file-data content into model-recognizable file part in model mode", () => {
    const result = normalizeToolResultForUserContent(
      {
        type: "content",
        value: [
          {
            type: "file-data",
            data: "YWJj",
            mediaType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
      {
        mode: "model",
      }
    );

    expect(result).toEqual([
      {
        type: "file",
        data: "YWJj",
        mediaType: "application/pdf",
        filename: "report.pdf",
      },
    ]);
  });

  it("falls back to text placeholder for file-id in model mode", () => {
    const result = normalizeToolResultForUserContent(
      {
        type: "content",
        value: [{ type: "file-id", fileId: "file-123" }],
      },
      {
        mode: "model",
      }
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "[File ID: file-123]",
      },
    ]);
  });

  it("returns text part output when mode is not model", () => {
    const result = normalizeToolResultForUserContent(
      {
        type: "content",
        value: [{ type: "image-url", url: "https://example.com/a.png" }],
      },
      {
        mode: "placeholder",
      }
    );

    expect(result).toEqual([
      {
        type: "text",
        text: "[Image URL: https://example.com/a.png]",
      },
    ]);
  });
});
