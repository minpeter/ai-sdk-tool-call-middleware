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

describe("morphXmlProtocol streaming: progressive text emission", () => {
  it("emits text-delta progressively when no tool tags are present", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [];
    const transformer = protocol.createStreamParser({ tools });

    const chunks = ["Hello ", "world, ", "this is ", "streamed text."];

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        for (const c of chunks) {
          ctrl.enqueue({ type: "text-delta", id: "t", delta: c });
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
    const deltas = out.filter(p => p.type === "text-delta");
    // Should have emitted each chunk (no coalescing into one big delta)
    expect(deltas.map(d => d.delta)).toEqual(chunks);
  });

  it("emits text progressively around tool tags, buffering minimal tail to detect split tags", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV2FunctionTool[] = [
      { type: "function", name: "echo", inputSchema: { type: "object" } },
    ];
    const transformer = protocol.createStreamParser({ tools });

    const parts = [
      "Before ",
      "text <ec",
      "ho>",
      "<msg>hi</msg>",
      "</echo>",
      " after",
    ];

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        for (const p of parts) {
          ctrl.enqueue({ type: "text-delta", id: "t", delta: p });
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
    // Expect text-deltas for "Before " and then minimal holding for split tag
    const textDeltas = out.filter(p => p.type === "text-delta");

    // Concatenate text deltas that occur before the tool-call
    const beforeTool = [] as string[];
    for (const td of textDeltas) {
      // Stop at the moment we have already emitted the start tag (tool-call breaks text)
      beforeTool.push(td.delta);
      if (td.delta.includes("<echo>")) break;
    }
    const beforeCombined = beforeTool.join("");
    expect(beforeCombined.startsWith("Before ")).toBe(true);

    // Ensure tool-call exists
    const hasTool = out.some(p => p.type === "tool-call");
    expect(hasTool).toBe(true);
  });

  it("handles DOCTYPE HTML without entity escaping inside string-typed arg (progress text)", async () => {
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
    const html = `<!DOCTYPE html>\n<html><body><h1>ok</h1></body></html>`;

    const rs = new ReadableStream<LanguageModelV2StreamPart>({
      start(ctrl) {
        const src = `<file_write><path>index.html</path><content>${html}</content></file_write>`;
        for (let i = 0; i < src.length; i += 9) {
          ctrl.enqueue({
            type: "text-delta",
            id: "t",
            delta: src.slice(i, i + 9),
          });
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
    if (!tool) throw new Error("Expected tool-call");
    const args = JSON.parse(tool.input) as { path: string; content: string };
    expect(args.path).toBe("index.html");
    expect(args.content).toBe(html);
  });
});
