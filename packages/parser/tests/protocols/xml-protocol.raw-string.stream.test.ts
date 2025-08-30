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
          for (let i = 0; i < p.length; i += 7) {
            ctrl.enqueue({
              type: "text-delta",
              id: "t",
              delta: p.slice(i, i + 7),
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

    const tool = out.find(p => p.type === "tool-call") as any;
    expect(tool?.toolName).toBe("write_file");
    const args = JSON.parse(tool.input);
    expect(args.file_path).toBe("/home/username/myfile.html");
    expect(args.content).toBe(html);
    expect(args.encoding).toBe("utf-8");
  });
});
