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

  it("supports attributes on string-typed tag and preserves only inner raw content (no sibling bleed)", () => {
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

    const htmlInner = `<div><h1>Title</h1><p>Para</p><em>italic</em></div>`;
    const text =
      `<write_file>` +
      `<file_path>/home/u/file.html</file_path>` +
      // Attribute on the string-typed tag
      `<content type="html">${htmlInner}</content>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    expect(tc?.toolName).toBe("write_file");
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    // Raw inner content preserved exactly
    expect(args.content).toBe(htmlInner);
    // Sibling fields parsed as usual
    expect(args.file_path).toBe("/home/u/file.html");
    expect(args.encoding).toBe("utf-8");
    // Ensure we did not include sibling markup in content
    expect(String(args.content)).not.toContain("<file_path>");
    expect(String(args.content)).not.toContain("<encoding>");
  });

  it("preserves nested markup inside string-typed tag even if it looks like sibling tags", () => {
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

    const htmlInner =
      `<html lang="en" encoding="utf-8">` +
      ` <head>` +
      `   <title>Title</title>` +
      ` </head>` +
      ` <body>` +
      `   <h1>Title</h1>` +
      `   <p>Para</p>` +
      `   <em>italic</em>` +
      ` </body>` +
      `</html>`;

    const text =
      `<write_file>` +
      `<file_path>/home/u/file.html</file_path>` +
      `<content>${htmlInner}</content>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    expect(tc?.toolName).toBe("write_file");
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    // Raw inner content preserved exactly
    expect(args.content).toBe(htmlInner);
    // Sibling fields parsed as usual
    expect(args.file_path).toBe("/home/u/file.html");
    expect(args.encoding).toBe("utf-8");
    // Ensure we did not include sibling markup in content
    expect(String(args.content)).not.toContain("<file_path>");
    expect(String(args.content)).not.toContain("<encoding>");
  });

  it("handles nested markup inside string-typed tag that looks like sibling tags", () => {
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

    // Include markup that resembles another known tag name (<encoding>) inside content
    const trickyInner = `Hello <encoding>not-a-sibling</encoding> World!`;
    const text =
      `<write_file>` +
      `<file_path>/tmp/file.txt</file_path>` +
      `<content>${trickyInner}</content>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    expect(tc?.toolName).toBe("write_file");
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;

    // The content should be the raw inner string including the nested <encoding>...</encoding>
    expect(args.content).toBe(trickyInner);
    // The sibling encoding field should still be parsed from its own tag
    expect(args.encoding).toBe("utf-8");
  });

  it("treats self-closing string-typed tag as empty string and parses siblings", () => {
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

    const text =
      `<write_file>` +
      `<file_path>/tmp/empty.txt</file_path>` +
      `<content/>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    expect(args.file_path).toBe("/tmp/empty.txt");
    expect(args.content).toBe("");
    expect(args.encoding).toBe("utf-8");
  });

  it("handles attribute values containing '>' and quotes on string-typed tag", () => {
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

    const inner = `Some text`;
    const text =
      `<write_file>` +
      `<file_path>/tmp/file.txt</file_path>` +
      `<content data="a > b" note="it's ok">${inner}</content>` +
      `<encoding>utf-8</encoding>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    expect(args.content).toBe(inner);
    expect(args.encoding).toBe("utf-8");
  });

  it("selects the shallowest occurrence when same-named tag exists nested and as sibling", () => {
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
      `<outer><content>nested</content></outer>` +
      `<content>top</content>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const isText = (
      p: LanguageModelV2Content
    ): p is { type: "text"; text: string } => p.type === "text";
    const only = out.find(isText);
    expect(only?.text).toBe(text);
  });

  it("cancels when duplicate string-typed tags include a self-closing and non-empty", () => {
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
      `<content/>` +
      `<content>non-empty</content>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const isText = (
      p: LanguageModelV2Content
    ): p is { type: "text"; text: string } => p.type === "text";
    const only = out.find(isText);
    expect(only?.text).toBe(text);
  });

  it("preserves CDATA blocks inside string-typed tag as raw content", () => {
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

    const inner = `<![CDATA[<encoding>not-sibling</encoding>]]>`;
    const text =
      `<write_file>` +
      `<file_path>/tmp/file.txt</file_path>` +
      `<content>${inner}</content>` +
      `</write_file>`;

    const out = protocol.parseGeneratedText({ text, tools, options: {} });
    const tc = out.find(isToolCallContent);
    const args =
      typeof tc?.input === "string" ? JSON.parse(tc.input) : tc?.input;
    expect(args.content).toBe(inner);
  });
});
