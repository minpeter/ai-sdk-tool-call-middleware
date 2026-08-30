import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

const fullProgressParseWork = vi.hoisted(() => ({ characters: 0 }));

vi.mock(
  "../../../../core/protocols/morph-xml-stream-progress",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../core/protocols/morph-xml-stream-progress")
      >();
    return {
      ...actual,
      parseXmlContentForStreamProgressWithMeta: (
        ...args: Parameters<
          typeof actual.parseXmlContentForStreamProgressWithMeta
        >
      ) => {
        fullProgressParseWork.characters += args[0].toolContent.length;
        return actual.parseXmlContentForStreamProgressWithMeta(...args);
      },
    };
  }
);

const tools = [
  {
    type: "function",
    name: "write_file",
    description: "write a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
] as any;

async function streamLargeToolCall(lines: number): Promise<{
  input: string;
  textLength: number;
}> {
  const body = Array.from(
    { length: lines },
    (_, i) => `line ${i}: const value_${i} = compute(${i});`
  ).join("\n");
  const text = `<write_file>\n<path>src/out.ts</path>\n<content>\n${body}\n</content>\n</write_file>`;

  const protocol = morphXmlProtocol();
  const transformer = protocol.createStreamParser({ tools });
  const chunkSize = 30;
  const rs = new ReadableStream<LanguageModelV4StreamPart>({
    start(ctrl) {
      for (let pos = 0; pos < text.length; pos += chunkSize) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: text.slice(pos, pos + chunkSize),
        });
      }
      ctrl.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      ctrl.close();
    },
  });
  const parts = await convertReadableStreamToArray(
    pipeWithTransformer(rs, transformer)
  );
  const toolCall = parts.find((part) => part.type === "tool-call");
  return {
    input: toolCall?.type === "tool-call" ? toolCall.input : "",
    textLength: text.length,
  };
}

describe("morph-xml large streamed tool call scaling", () => {
  it("bounds full progress parsing work for a ~173KB streamed string argument", async () => {
    fullProgressParseWork.characters = 0;
    const { input, textLength } = await streamLargeToolCall(4000);

    const parsed = JSON.parse(input);
    expect(parsed.path).toBe("src/out.ts");
    expect(parsed.content).toContain("line 3999:");

    expect(fullProgressParseWork.characters).toBeLessThan(textLength * 3);
  }, 30_000);
});
