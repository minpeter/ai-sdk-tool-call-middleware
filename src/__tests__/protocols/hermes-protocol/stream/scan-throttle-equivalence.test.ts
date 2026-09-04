import {
  isJSONObject,
  type JSONValue,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const boundaryScanWork = vi.hoisted(() => ({ characters: 0 }));

async function instrumentBoundaryScanner(
  importOriginal: () => Promise<
    typeof import("../../../../core/protocols/hermes-call-boundary")
  >
) {
  const actual = await importOriginal();
  const instrumented = (
    ...parameters: Parameters<
      typeof actual.findToolCallBoundaryOutsideRjsonSyntax
    >
  ) => {
    boundaryScanWork.characters += parameters[0].length;
    return actual.findToolCallBoundaryOutsideRjsonSyntax(...parameters);
  };
  return { ...actual, findToolCallBoundaryOutsideRjsonSyntax: instrumented };
}

vi.mock(
  "../../../../core/protocols/hermes-call-boundary",
  instrumentBoundaryScanner
);

const writeFileTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "write_file",
  description: "write a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};
const weatherTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "get weather",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};
const tools = [writeFileTool, weatherTool];

function streamInChunks(
  text: string,
  chunkSize: number
): Promise<LanguageModelV4StreamPart[]> {
  const chunks: string[] = [];
  for (let position = 0; position < text.length; position += chunkSize) {
    chunks.push(text.slice(position, position + chunkSize));
  }
  return runProtocolTextStream({
    protocol: hermesProtocol(),
    tools,
    chunks,
    id: "1",
  });
}

function summarize(parts: LanguageModelV4StreamPart[]): {
  toolCalls: { toolName: string; input: string }[];
  concatenatedDeltas: string;
  text: string;
} {
  return {
    toolCalls: selectToolCalls(parts).map(({ toolName, input }) => ({
      toolName,
      input,
    })),
    concatenatedDeltas: selectToolInputTimeline(parts)
      .deltas.map(({ delta }) => delta)
      .join(""),
    text: collectTextDeltas(parts),
  };
}

function largeBody(lines: number): string {
  const body: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    body.push(`line ${index}: const value_${index} = compute(${index});`);
  }
  return body.join("\n");
}

function parseInputContent(input: string): JSONValue {
  const parsed: JSONValue = JSON.parse(input);
  if (!isJSONObject(parsed) || parsed.content === undefined) {
    throw new TypeError("Expected tool-call input content");
  }
  return parsed.content;
}

function hermesCall(toolName: string, args: JSONValue): string {
  return `<tool_call>\n${JSON.stringify({ name: toolName, arguments: args })}\n</tool_call>`;
}

const scalingChunkSize = 30;

async function baselineSummary(text: string, expectedCalls?: number) {
  const whole = summarize(await streamInChunks(text, text.length));
  if (expectedCalls !== undefined) {
    expect(whole.toolCalls).toHaveLength(expectedCalls);
  }
  return whole;
}

interface ChunkEquivalence {
  readonly chunkSizes: readonly number[];
  readonly compareText: boolean;
  readonly text: string;
  readonly whole: ReturnType<typeof summarize>;
}

async function expectChunkEquivalence(
  options: ChunkEquivalence
): Promise<void> {
  for (const chunkSize of options.chunkSizes) {
    const chunked = summarize(await streamInChunks(options.text, chunkSize));
    expect(chunked.toolCalls).toEqual(options.whole.toolCalls);
    if (options.compareText) {
      expect(chunked.text.trim()).toBe(options.whole.text.trim());
    }
  }
}

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

    const whole = await baselineSummary(text, 1);
    await expectChunkEquivalence({
      text,
      whole,
      chunkSizes: [7, 30, 301],
      compareText: false,
    });
  });

  it("handles trailing text and a second tool call after a large one", async () => {
    const text = `${hermesCall("write_file", {
      path: "a.ts",
      content: largeBody(400),
    })}\nplain trailing text\n${hermesCall("get_weather", { city: "Seoul" })}`;

    const whole = await baselineSummary(text, 2);
    await expectChunkEquivalence({
      text,
      whole,
      chunkSizes: [13, 64],
      compareText: true,
    });
  });

  it("completes a call whose end tag arrives right at stream end", async () => {
    // No trailing content after </tool_call>: completion relies on either
    // the carry-based tag trigger or the finish catch-up scan.
    const text = hermesCall("write_file", {
      path: "a.ts",
      content: largeBody(400),
    });

    const whole = await baselineSummary(text);
    for (const chunkSize of [3, 17]) {
      const chunked = summarize(await streamInChunks(text, chunkSize));
      expect(chunked.toolCalls).toEqual(whole.toolCalls);
      expect(parseInputContent(chunked.toolCalls[0].input)).toContain(
        "line 399:"
      );
    }
  });

  it("is not fooled by end-tag text inside a large JSON string value", async () => {
    // The literal tag text inside the string is a deferral-trigger false
    // positive: the forced full scan must see it is inside a string and keep
    // going until the real close tag.
    const content = `${largeBody(200)}\nfake tag: </tool_call> inside string\n${largeBody(200)}`;
    const text = hermesCall("write_file", { path: "a.ts", content });

    const whole = await baselineSummary(text, 1);

    const chunked = summarize(await streamInChunks(text, 23));
    expect(chunked.toolCalls).toEqual(whole.toolCalls);
    expect(parseInputContent(chunked.toolCalls[0].input)).toContain(
      "fake tag: </tool_call> inside string"
    );
  });

  it("recovers an unclosed large call at finish identically for any chunking", async () => {
    const body = JSON.stringify({
      name: "write_file",
      arguments: { path: "a.ts", content: largeBody(400) },
    });
    const text = `<tool_call>\n${body}`; // missing </tool_call>

    const whole = await baselineSummary(text);
    await expectChunkEquivalence({
      text,
      whole,
      chunkSizes: [11, 47],
      compareText: true,
    });
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
      const parsed: JSONValue = JSON.parse(toolCalls[0].input);
      if (!isJSONObject(parsed)) {
        throw new TypeError("Expected tool-call input to be a JSON object");
      }
      expect(parsed.content).toContain(`line ${lines - 1}:`);

      const naiveCharacters = naiveEveryChunkRescanCharacters(text.length);
      expect(boundaryScanWork.characters * 10).toBeLessThan(naiveCharacters);
    },
    30_000
  );
});
