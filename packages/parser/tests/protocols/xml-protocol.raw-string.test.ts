import type { LanguageModelV2FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

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
    const tc = out.find(p => (p as any).type === "tool-call") as any;
    expect(tc?.toolName).toBe("write_file");
    const args = JSON.parse(tc.input);
    expect(args.file_path).toBe("/home/username/myfile.html");
    // Content must be the raw inner string including XML-like tags
    expect(args.content).toBe(html);
    expect(args.encoding).toBe("utf-8");
  });
});
