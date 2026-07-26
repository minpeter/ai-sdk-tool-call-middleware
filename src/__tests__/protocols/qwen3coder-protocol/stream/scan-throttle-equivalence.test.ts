import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
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
  {
    type: "function",
    name: "get_weather",
    description: "get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
] as any;

function streamInChunks(
  text: string,
  chunkSize: number
): Promise<LanguageModelV4StreamPart[]> {
  const protocol = qwen3CoderProtocol();
  const transformer = protocol.createStreamParser({ tools });
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
  return convertReadableStreamToArray(pipeWithTransformer(rs, transformer));
}

function summarize(parts: LanguageModelV4StreamPart[]): {
  toolCalls: { toolName: string; input: string }[];
  concatenatedDeltas: string;
  text: string;
} {
  const toolCalls: { toolName: string; input: string }[] = [];
  let concatenatedDeltas = "";
  let text = "";
  for (const part of parts) {
    if (part.type === "tool-call") {
      toolCalls.push({ toolName: part.toolName, input: part.input });
    } else if (part.type === "tool-input-delta") {
      concatenatedDeltas += part.delta;
    } else if (part.type === "text-delta") {
      text += part.delta;
    }
  }
  return { toolCalls, concatenatedDeltas, text };
}

function largeBody(lines: number): string {
  return Array.from(
    { length: lines },
    (_, i) => `line ${i}: const value_${i} = compute(${i});`
  ).join("\n");
}

describe("qwen3coder scan-throttle equivalence (deferral active above 4KB)", () => {
  // Deferral only activates once the call buffer exceeds 4KB, so these
  // payloads must be large enough to exercise the deferred path against the
  // single-chunk run (which never defers).
  it("produces identical final tool calls for large streamed arguments", async () => {
    const body = largeBody(500); // ~20KB
    const text = `<tool_call>\n<function=write_file>\n<parameter=path>a.ts</parameter>\n<parameter=content>\n${body}\n</parameter>\n</function>\n</tool_call>`;

    const whole = summarize(await streamInChunks(text, text.length));
    expect(whole.toolCalls).toHaveLength(1);

    for (const chunkSize of [7, 30, 301]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      // Deltas are coarser under deferral but must still form a prefix of
      // the final input.
      expect(
        whole.toolCalls[0].input.startsWith(chunked.concatenatedDeltas)
      ).toBe(true);
    }
  });

  it("handles trailing text and a second tool call after a deferred close tag", async () => {
    const body = largeBody(400);
    const text = `<tool_call>\n<function=write_file>\n<parameter=path>a.ts</parameter>\n<parameter=content>\n${body}\n</parameter>\n</function>\n</tool_call>\nplain trailing text\n<tool_call>\n<function=get_weather>\n<parameter=city>Seoul</parameter>\n</function>\n</tool_call>`;

    const whole = summarize(await streamInChunks(text, text.length));
    expect(whole.toolCalls).toHaveLength(2);

    for (const chunkSize of [13, 64]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      expect(chunked.text.trim()).toBe(whole.text.trim());
    }
  });

  it("finishes a call whose close tag arrives inside the deferral window at stream end", async () => {
    const body = largeBody(400);
    // No trailing text after the close tag: the close tag lands in the
    // deferred window right before finish, forcing the catch-up scan path.
    const text = `<tool_call>\n<function=write_file>\n<parameter=path>a.ts</parameter>\n<parameter=content>\n${body}\n</parameter>\n</function>\n</tool_call>`;

    const whole = summarize(await streamInChunks(text, text.length));
    const chunked = summarize(await streamInChunks(text, 17));
    expect(chunked.toolCalls).toEqual(whole.toolCalls);

    const parsed = JSON.parse(chunked.toolCalls[0].input);
    expect(parsed.path).toBe("a.ts");
    expect(parsed.content).toContain("line 399:");
  });

  it("keeps implicit (missing <tool_call>) calls identical under deferral", async () => {
    const body = largeBody(400);
    const text = `<function=write_file>\n<parameter=path>a.ts</parameter>\n<parameter=content>\n${body}\n</parameter>\n</function>`;

    const whole = summarize(await streamInChunks(text, text.length));
    const chunked = summarize(await streamInChunks(text, 19));
    expect(chunked.toolCalls).toEqual(whole.toolCalls);
    expect(chunked.toolCalls).toHaveLength(1);
  });
});

describe("qwen3coder large streamed tool call scaling", () => {
  // Regression guard: before scan throttling, a ~173KB string argument
  // streamed in 30-char chunks rescanned the whole call buffer per chunk
  // (O(n^2), ~6.8s on a dev machine). Amortized scanning is ~120x faster;
  // the generous bound keeps slow CI stable while still failing loudly on a
  // quadratic regression.
  it("parses a ~173KB streamed string argument well under the quadratic regime", async () => {
    const body = largeBody(4000);
    const text = `<tool_call>\n<function=write_file>\n<parameter=path>a.ts</parameter>\n<parameter=content>\n${body}\n</parameter>\n</function>\n</tool_call>`;

    const start = performance.now();
    const parts = await streamInChunks(text, 30);
    const elapsedMs = performance.now() - start;

    const { toolCalls } = summarize(parts);
    expect(toolCalls).toHaveLength(1);
    const parsed = JSON.parse(toolCalls[0].input);
    expect(parsed.content).toContain("line 3999:");

    expect(elapsedMs).toBeLessThan(1500);
  }, 30_000);
});
