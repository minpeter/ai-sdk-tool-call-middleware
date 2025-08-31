import type {
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";
import { isToolCallContent } from "@/utils/type-guards";

describe("morphXmlProtocol raw string handling by schema", () => {
  it("treats string-typed args as raw text, not nested XML", () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "write_file",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
            encoding: { type: "string" },
          },
          required: ["file_path", "content"],
        },
      },
    ];

    const html = `<html><body><h1>Title</h1><p>Para</p></body></html>`;
    const text =
      `<write_file>` +
      `<file_path>/home/username/myfile.html</file_path>` +
      `<content>${html}</content>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    expect(tc?.toolName).toBe("write_file");
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    expect(args.file_path).toBe("/home/username/myfile.html");
    // Content must be the raw inner string including XML-like tags
    expect(args.content).toBe(html);
    expect(args.encoding).toBe("utf-8");
  });

  it("cancels entire tool call when duplicate string tags are emitted (non-stream)", () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "write_file",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          required: ["file_path", "content"],
        },
      },
    ];

    const text =
      `<write_file>` +
      `<file_path>/tmp/file.txt</file_path>` +
      `<content>part1</content>` +
      `<content>part2</content>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    // Entire tool call should be cancelled and returned as text
    const isText = (
      p: LanguageModelV2Content
    ): p is { type: "text"; text: string } => p.type === "text";
    const only = out.find(isText);
    expect(only?.text).toBe(text);
  });
});
