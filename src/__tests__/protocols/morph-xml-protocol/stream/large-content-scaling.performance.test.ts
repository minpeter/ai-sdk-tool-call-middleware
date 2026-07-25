import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

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
  elapsedMs: number;
  input: string;
}> {
  const body = Array.from(
    { length: lines },
    (_, i) => `line ${i}: const value_${i} = compute(${i});`
  ).join("\n");
  const text = `<write_file>\n<path>src/out.ts</path>\n<content>\n${body}\n</content>\n</write_file>`;

  const protocol = morphXmlProtocol();
  const transformer = protocol.createStreamParser({ tools });
  const chunkSize = 30;
  const start = performance.now();
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
  const elapsedMs = performance.now() - start;
  const toolCall = parts.find((part) => part.type === "tool-call");
  return {
    elapsedMs,
    input: toolCall?.type === "tool-call" ? toolCall.input : "",
  };
}

describe("morph-xml large streamed tool call scaling", () => {
  // Regression guard for the incremental streaming progress path. Before the
  // incremental shortcut, a ~173KB string argument streamed in 30-char chunks
  // re-parsed the accumulated buffer on every chunk (O(n^2), ~2.6s on a dev
  // machine). The incremental path is ~40x faster; the generous bound keeps
  // the test stable on slow CI while still failing loudly on a quadratic
  // regression.
  it("parses a ~173KB streamed string argument well under the quadratic regime", async () => {
    const { elapsedMs, input } = await streamLargeToolCall(4000);

    const parsed = JSON.parse(input);
    expect(parsed.path).toBe("src/out.ts");
    expect(parsed.content).toContain("line 3999:");

    expect(elapsedMs).toBeLessThan(1500);
  }, 30_000);
});
