import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

const boundaryScanWork = vi.hoisted(() => ({ characters: 0 }));

vi.mock(
  "../../../../core/protocols/hermes-call-boundary",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../core/protocols/hermes-call-boundary")
      >();
    return {
      ...actual,
      findToolCallBoundaryOutsideRjsonSyntax: (
        ...args: Parameters<
          typeof actual.findToolCallBoundaryOutsideRjsonSyntax
        >
      ) => {
        boundaryScanWork.characters += args[0].length;
        return actual.findToolCallBoundaryOutsideRjsonSyntax(...args);
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
  const protocol = hermesProtocol();
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

function hermesCall(toolName: string, args: unknown): string {
  return `<tool_call>\n${JSON.stringify({ name: toolName, arguments: args })}\n</tool_call>`;
}

const scalingChunkSize = 30;

function naiveEveryChunkRescanCharacters(textLength: number): number {
  let characters = 0;
  for (
    let length = scalingChunkSize;
    length < textLength;
    length += scalingChunkSize
  ) {
    characters += length;
  }
  return characters + textLength;
}

describe("hermes scan-throttle equivalence (deferral active above 4KB)", () => {
  // Deferral only activates once the accumulated tool-call JSON exceeds 4KB,
  // so these payloads must be large enough to exercise the deferred path
  // against the single-chunk run (which never defers).
  it("produces identical final tool calls for large streamed arguments", async () => {
    const text = hermesCall("write_file", {
      path: "a.ts",
      content: largeBody(500), // ~20KB
    });

    const whole = summarize(await streamInChunks(text, text.length));
    expect(whole.toolCalls).toHaveLength(1);

    for (const chunkSize of [7, 30, 301]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
    }
  });

  it("handles trailing text and a second tool call after a large one", async () => {
    const text = `${hermesCall("write_file", {
      path: "a.ts",
      content: largeBody(400),
    })}\nplain trailing text\n${hermesCall("get_weather", { city: "Seoul" })}`;

    const whole = summarize(await streamInChunks(text, text.length));
    expect(whole.toolCalls).toHaveLength(2);

    for (const chunkSize of [13, 64]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      expect(chunked.text.trim()).toBe(whole.text.trim());
    }
  });

  it("completes a call whose end tag arrives right at stream end", async () => {
    // No trailing content after </tool_call>: completion relies on either
    // the carry-based tag trigger or the finish catch-up scan.
    const text = hermesCall("write_file", {
      path: "a.ts",
      content: largeBody(400),
    });

    const whole = summarize(await streamInChunks(text, text.length));
    for (const chunkSize of [3, 17]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      const parsed = JSON.parse(chunked.toolCalls[0].input);
      expect(parsed.content).toContain("line 399:");
    }
  });

  it("is not fooled by end-tag text inside a large JSON string value", async () => {
    // The literal tag text inside the string is a deferral-trigger false
    // positive: the forced full scan must see it is inside a string and keep
    // going until the real close tag.
    const content = `${largeBody(200)}\nfake tag: </tool_call> inside string\n${largeBody(200)}`;
    const text = hermesCall("write_file", { path: "a.ts", content });

    const whole = summarize(await streamInChunks(text, text.length));
    expect(whole.toolCalls).toHaveLength(1);

    const chunked = summarize(await streamInChunks(text, 23));
    expect(chunked.toolCalls).toEqual(whole.toolCalls);
    const parsed = JSON.parse(chunked.toolCalls[0].input);
    expect(parsed.content).toContain("fake tag: </tool_call> inside string");
  });

  it("recovers an unclosed large call at finish identically for any chunking", async () => {
    const body = JSON.stringify({
      name: "write_file",
      arguments: { path: "a.ts", content: largeBody(400) },
    });
    const text = `<tool_call>\n${body}`; // missing </tool_call>

    const whole = summarize(await streamInChunks(text, text.length));
    for (const chunkSize of [11, 47]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      expect(chunked.text.trim()).toBe(whole.text.trim());
    }
  });
});

describe("hermes large streamed tool call scaling", () => {
  // Before #398, every 30-character chunk rescanned the accumulated JSON:
  // the exact arithmetic-series sum below models that O(n^2) work. Capped
  // scan deferral intentionally remains O(n^2 / 1024), so comparing against
  // a linear text-length budget is not scale invariant. Requiring at least a
  // 10x reduction from naive rescanning preserves the algorithmic regression
  // signal at every fixture size.
  //
  // #398 measured roughly 2.1s -> 38ms on its development setup (before the
  // final steady-cadence cap). That plain-machine figure is not an absolute
  // CI SLA: at this exact head the same case measured 298ms plain versus
  // 1444ms with V8 coverage, with identical outputs and scan work. The work
  // ratio isolates parser complexity from instrumentation and runner load.
  it.each([1000, 2000, 4000])(
    "reduces boundary-scan work by at least 10x for %i streamed lines",
    async (lines) => {
      const text = hermesCall("write_file", {
        path: "a.ts",
        content: largeBody(lines),
      });

      boundaryScanWork.characters = 0;
      const parts = await streamInChunks(text, scalingChunkSize);

      const { toolCalls } = summarize(parts);
      expect(toolCalls).toHaveLength(1);
      const parsed = JSON.parse(toolCalls[0].input);
      expect(parsed.content).toContain(`line ${lines - 1}:`);

      const naiveCharacters = naiveEveryChunkRescanCharacters(text.length);
      expect(boundaryScanWork.characters * 10).toBeLessThan(naiveCharacters);
    },
    30_000
  );
});
