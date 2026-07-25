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

async function streamInChunks(
  text: string,
  chunkSizes: number[],
  onError?: (message: string, metadata?: Record<string, unknown>) => void
): Promise<LanguageModelV4StreamPart[]> {
  const protocol = morphXmlProtocol();
  const transformer = protocol.createStreamParser({
    tools,
    options: onError ? { onError } : undefined,
  });
  const rs = new ReadableStream<LanguageModelV4StreamPart>({
    start(ctrl) {
      let pos = 0;
      let sizeIndex = 0;
      while (pos < text.length) {
        const size = chunkSizes[sizeIndex % chunkSizes.length];
        sizeIndex += 1;
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: text.slice(pos, pos + size),
        });
        pos += size;
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
  toolInputs: string[];
  concatenatedDeltas: string;
  text: string;
} {
  const toolInputs: string[] = [];
  let concatenatedDeltas = "";
  let text = "";
  for (const part of parts) {
    if (part.type === "tool-call") {
      toolInputs.push(part.input);
    } else if (part.type === "tool-input-delta") {
      concatenatedDeltas += part.delta;
    } else if (part.type === "text-delta") {
      text += part.delta;
    }
  }
  return { toolInputs, concatenatedDeltas, text };
}

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
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
  for (let i = 0; i < count; i += 1) {
    bodyParts.push(BODY_FRAGMENTS[Math.floor(rand() * BODY_FRAGMENTS.length)]);
  }
  const body = bodyParts.join("");
  return `before text <write_file>\n<path>src/a.ts</path>\n<content>\n${body}</content>\n</write_file> after text`;
}

describe("morph-xml incremental streaming progress equivalence", () => {
  it("produces identical tool calls regardless of chunk boundaries", async () => {
    const rand = mulberry32(1234);
    let roundsWithToolCall = 0;
    for (let round = 0; round < 25; round += 1) {
      const text = randomToolCallText(rand);
      const whole = summarize(await streamInChunks(text, [text.length]));

      // Random small chunk sizes exercise every split point class: inside
      // tags, across the closing tag, inside entities, etc.
      const sizes: number[] = [];
      for (let i = 0; i < 8; i += 1) {
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
            whole.toolInputs[0].startsWith(chunked.concatenatedDeltas)
          ).toBe(true);
        }
      }
    }

    // The generator must not degenerate into only-unparseable bodies.
    expect(roundsWithToolCall).toBeGreaterThan(12);
  });

  it("handles closing tags with internal whitespace split across chunks", async () => {
    const text =
      "<write_file>\n<path>a.ts</path>\n<content>\nhello\n</content>\n</   write_file   >";
    for (const sizes of [[1], [2], [3], [5], [7], [text.length]]) {
      const out = summarize(await streamInChunks(text, sizes));
      expect(out.toolInputs).toHaveLength(1);
      expect(JSON.parse(out.toolInputs[0])).toMatchObject({ path: "a.ts" });
    }
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
