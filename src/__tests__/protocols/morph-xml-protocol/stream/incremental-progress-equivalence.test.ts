import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { ProtocolMetadata } from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const writeFileTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "write_file",
  description: "write a file",
  inputSchema: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
};

function splitBySizes(text: string, chunkSizes: readonly number[]): string[] {
  const chunks: string[] = [];
  let position = 0;
  let sizeIndex = 0;
  while (position < text.length) {
    const size = chunkSizes[sizeIndex % chunkSizes.length];
    if (size === undefined) {
      throw new RangeError("At least one chunk size is required");
    }
    chunks.push(text.slice(position, position + size));
    position += size;
    sizeIndex += 1;
  }
  return chunks;
}

function streamInChunks(
  text: string,
  chunkSizes: readonly number[],
  onError?: (message: string, metadata?: ProtocolMetadata) => void
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks: splitBySizes(text, chunkSizes),
    id: "1",
    protocol: morphXmlProtocol(),
    tools: [writeFileTool],
    ...(onError === undefined ? {} : { parserOptions: { onError } }),
  });
}

function summarize(parts: readonly LanguageModelV4StreamPart[]) {
  const timeline = selectToolInputTimeline(parts);
  return {
    toolInputs: selectToolCalls(parts).map((part) => part.input),
    concatenatedDeltas: timeline.deltas.map((part) => part.delta).join(""),
    text: collectTextDeltas(parts),
  };
}

// Deterministic PRNG (Park-Miller LCG) so failures are reproducible.
function createSeededRandom(seed: number): () => number {
  const modulus = 2_147_483_647;
  let state = seed % modulus;
  if (state <= 0) {
    state += modulus - 1;
  }
  return () => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
}

const BODY_FRAGMENTS = [
  "plain text line\n",
  "code: const f = (a) => a > 1;\n",
  "entities &amp; more &lt;stuff&gt;\n",
  "angle < open and close > separately\n",
  "almost a close </wri tag\n",
  "almost close 2 </write_fi\n",
  "nested-looking <content> body\n",
  "self close <thing/> here\n",
  "unicode \u00a0 space and \uac00\ub098\ub2e4\n",
  "quotes \"double\" and 'single'\n",
];

function randomToolCallText(rand: () => number): string {
  const bodyParts: string[] = [];
  const count = 3 + Math.floor(rand() * 20);
  for (let index = 0; index < count; index += 1) {
    const fragment = BODY_FRAGMENTS[Math.floor(rand() * BODY_FRAGMENTS.length)];
    if (fragment === undefined) {
      throw new RangeError("Generated fragment index must be in range");
    }
    bodyParts.push(fragment);
  }
  return `before text <write_file>\n<path>src/a.ts</path>\n<content>\n${bodyParts.join("")}</content>\n</write_file> after text`;
}

describe("morph-xml incremental streaming progress equivalence", () => {
  it("produces identical tool calls regardless of chunk boundaries", async () => {
    const rand = createSeededRandom(1234);
    let roundsWithToolCall = 0;
    for (let round = 0; round < 25; round += 1) {
      const text = randomToolCallText(rand);
      const whole = summarize(await streamInChunks(text, [text.length]));

      // Random small chunk sizes exercise every split point class: inside
      // tags, across the closing tag, inside entities, etc.
      const sizes: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        sizes.push(1 + Math.floor(rand() * 17));
      }
      let sawMismatch = false;
      const chunked = summarize(
        await streamInChunks(text, sizes, () => {
          sawMismatch = true;
        })
      );

      // Core invariant: chunk boundaries must never change the outcome,
      // including rounds where an adversarial body (e.g. nested tags) makes
      // the tool call unparseable in both runs.
      expect(chunked.toolInputs).toEqual(whole.toolInputs);
      expect(chunked.text).toBe(whole.text);

      if (whole.toolInputs.length === 1) {
        roundsWithToolCall += 1;
        // Unless the parser reported a progress/final mismatch (a
        // pre-existing possibility when intermediate structure guesses are
        // invalidated, e.g. by nested tags that reshape the parsed
        // arguments), the emitted deltas must form a prefix of the final
        // input.
        if (!sawMismatch) {
          expect(
            whole.toolInputs[0]?.startsWith(chunked.concatenatedDeltas)
          ).toBe(true);
        }
      }
    }

    // Sanity floor: the generator must not degenerate into only-unparseable
    // bodies (adversarial fragments like nested tags legitimately break some
    // rounds; with seed 1234 eleven of the 25 rounds stay parseable).
    expect(roundsWithToolCall).toBeGreaterThan(8);
  });

  it("handles closing tags with internal whitespace split across chunks", async () => {
    const text =
      "<write_file>\n<path>a.ts</path>\n<content>\nhello\n</content>\n</   write_file   >";
    for (const sizes of [[1], [2], [3], [5], [7], [text.length]]) {
      const out = summarize(await streamInChunks(text, sizes));
      expect(out.toolInputs).toHaveLength(1);
      expect(JSON.parse(out.toolInputs[0] ?? "{}")).toMatchObject({
        path: "a.ts",
      });
    }
  });

  it("live-streams a large strictly-string value in capped bursts", async () => {
    const body = Array.from(
      { length: 300 },
      (_, index) => `line ${index}: hello streaming world`
    ).join("\n"); // ~9KB
    const text = `<write_file>\n<path>a.ts</path>\n<content>\n${body}\n</content>\n</write_file>`;

    const parts = await streamInChunks(text, [25]);
    const { toolInputs, concatenatedDeltas } = summarize(parts);

    expect(toolInputs).toHaveLength(1);
    // The value body must stream while the tag is still open (capped ~1KB
    // bursts), not arrive as one delta at the end: expect several deltas
    // that already contain body content.
    expect(
      parts.filter((part) => part.type === "tool-input-delta").length
    ).toBeGreaterThan(5);
    // Raw-slice streaming must stay exactly prefix-consistent with the
    // final input.
    expect(toolInputs[0]?.startsWith(concatenatedDeltas)).toBe(true);
    expect(concatenatedDeltas).toBe(toolInputs[0]);
  });

  it("recovers unclosed tool calls at finish identically for any chunking", async () => {
    const text = "<write_file>\n<path>a.ts</path>\n<content>\nunclosed body";
    const whole = summarize(await streamInChunks(text, [text.length]));
    for (const sizes of [[1], [3], [10]]) {
      const chunked = summarize(await streamInChunks(text, sizes));
      expect(chunked.toolInputs).toEqual(whole.toolInputs);
      expect(chunked.text).toBe(whole.text);
    }
  });
});
