import {
  isJSONObject,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

function streamText(
  chunks: readonly string[],
  tools: LanguageModelV4FunctionTool[]
) {
  return runProtocolTextStream({
    protocol: morphXmlProtocol(),
    tools,
    id: "t",
    chunks,
  });
}

function chunksOf(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let position = 0; position < text.length; position += size) {
    chunks.push(text.slice(position, position + size));
  }
  return chunks;
}

describe("morphXmlProtocol streaming: progressive text emission", () => {
  it("emits text-delta progressively when no tool tags are present", async () => {
    const chunks = ["Hello ", "world, ", "this is ", "streamed text."];
    const out = await streamText(chunks, []);
    const deltas = out.filter((part) => part.type === "text-delta");
    // Should have emitted each chunk (no coalescing into one big delta)
    expect(deltas.map((part) => part.delta)).toEqual(chunks);
  });

  it("emits text progressively around tool tags, buffering minimal tail to detect split tags", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
      { type: "function", name: "echo", inputSchema: { type: "object" } },
    ];
    const parts = [
      "Before ",
      "text <ec",
      "ho>",
      "<msg>hi</msg>",
      "</echo>",
      " after",
    ];
    const out = await streamText(parts, tools);
    const textDeltas = out.filter((part) => part.type === "text-delta");

    const beforeTool: string[] = [];
    for (const textDelta of textDeltas) {
      beforeTool.push(textDelta.delta);
      if (textDelta.delta.includes("<echo>")) {
        break;
      }
    }
    expect(beforeTool.join("").startsWith("Before ")).toBe(true);
    expect(selectToolCalls(out)).not.toHaveLength(0);
  });

  it("handles DOCTYPE HTML without entity escaping inside string-typed arg (progress text)", async () => {
    const tools: LanguageModelV4FunctionTool[] = [
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
    const html = "<!DOCTYPE html>\n<html><body><h1>ok</h1></body></html>";
    const source = `<file_write><path>index.html</path><content>${html}</content></file_write>`;
    const out = await streamText(chunksOf(source, 9), tools);
    const toolCall = requireToolCall(out);
    expect(toolCall.toolName).toBe("file_write");
    const args = JSON.parse(toolCall.input);
    if (!isJSONObject(args)) {
      throw new TypeError("Expected file_write object input");
    }
    expect(args.path).toBe("index.html");
    expect(args.content).toBe(html);
  });
});
