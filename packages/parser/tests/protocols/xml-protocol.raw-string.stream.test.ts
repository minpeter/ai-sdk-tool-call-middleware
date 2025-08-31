import type {
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "@/protocols/morph-xml-protocol";

async function collect(stream: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  reader.releaseLock();
  return out;
}

describe("morphXmlProtocol raw string handling in streaming", () => {
  it("captures raw inner XML for string-typed arg during streaming", async () => {
    const CHUNK_SIZE = 7;
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

    const transformer = protocol.createStreamParser({ tools });
    const html = `<html><body><h1>Hi</h1><p>World</p></body></html>`;
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        const parts = [
          `<write_file>`,
          `<file_path>/home/username/myfile.html</file_path>`,
          `<content>`,
          html,
          `</content>`,
          `<encoding>utf-8</encoding>`,
          `</write_file>`,
        ];
        // emit in small chunks to simulate streaming
        for (const p of parts) {
          for (let i = 0; i < p.length; i += CHUNK_SIZE) {
            ctrl.enqueue({
              type: "text-delta",
              id: "t",
              delta: p.slice(i, i + CHUNK_SIZE),
            });
          }
        }
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));

    const tool = out.find(
      (p): p is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        p.type === "tool-call"
    );
    expect(tool?.toolName).toBe("write_file");
    if (!tool) throw new Error("Expected tool-call part to be present");
    const args = JSON.parse(tool.input) as {
      file_path: string;
      content: string;
      encoding?: string;
    };
    expect(args.file_path).toBe("/home/username/myfile.html");
    expect(args.content).toBe(html);
    expect(args.encoding).toBe("utf-8");
  });

  it("error policy cancels the tool call and emits original text in streaming", async () => {
    const CHUNK_SIZE = 5;
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
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        const parts = [
          `<write_file>`,
          `<file_path>/tmp/file.txt</file_path>`,
          `<content>part1</content>`,
          `<content>part2</content>`,
          `</write_file>`,
        ];
        for (const p of parts) {
          for (let i = 0; i < p.length; i += CHUNK_SIZE) {
            ctrl.enqueue({
              type: "text-delta",
              id: "t",
              delta: p.slice(i, i + CHUNK_SIZE),
            });
          }
        }
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    // Entire tool call is cancelled and returned as text stream
    const textParts = out.filter(
      (p): p is Extract<LanguageModelV2StreamPart, { type: "text-delta" }> =>
        p.type === "text-delta"
    );
    const combined = textParts.map(p => p.delta).join("");
    expect(combined).toContain("<write_file>");
    expect(combined).toContain(
      "<content>part1</content><content>part2</content>"
    );
    expect(combined).toContain("</write_file>");
    const hasToolCall = out.some(p => p.type === "tool-call");
    expect(hasToolCall).toBe(false);
  });

  it("captures DOCTYPE HTML inside string-typed <content> during streaming (user-reported)", async () => {
    const CHUNK_SIZE = 11;
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      {
        type: "function",
        name: "file_write",
        description: "Write a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ];

    const transformer = protocol.createStreamParser({ tools });
    const html = `<!DOCTYPE html>\n<html lang="en"> <head> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"> <title>Simple HTML Page</title> </head> <body> <h1>Hello World!</h1> <p>This is a simple HTML file.</p> <button>Click Me</button> </body> </html>`;
    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        const parts = [
          `<file_write>`,
          `<path>index.html</path>`,
          `<content>`,
          html,
          `</content>`,
          `</file_write>`,
        ];
        for (const p of parts) {
          for (let i = 0; i < p.length; i += CHUNK_SIZE) {
            ctrl.enqueue({
              type: "text-delta",
              id: "t",
              delta: p.slice(i, i + CHUNK_SIZE),
            });
          }
        }
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });

    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find(
      (p): p is Extract<LanguageModelV2StreamPart, { type: "tool-call" }> =>
        p.type === "tool-call"
    );
    expect(tool?.toolName).toBe("file_write");
    if (!tool) throw new Error("Expected tool-call part to be present");
    const args = JSON.parse(tool.input) as {
      path: string;
      content: string;
    };
    expect(args.path).toBe("index.html");
    expect(args.content).toBe(html);
  });
});
