import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

// Regression tests for streaming latency: text containing tag-like substrings
// such as `<callback>` or `<toolbar>` must not be withheld until finish.
describe("qwen3CoderProtocol stream text flushing", () => {
  async function collectWhileOpen(
    deltas: string[],
    expectedParts: number
  ): Promise<LanguageModelV4StreamPart[]> {
    const parser = qwen3CoderProtocol().createStreamParser({
      tools: emptyFunctionTools,
    });
    const writer = parser.writable.getWriter();
    const reader = parser.readable.getReader();

    // Deliberately no close(): the parts must be readable while the stream
    // is still open, otherwise the text was buffered until finish.
    const writes = (async () => {
      for (const delta of deltas) {
        await writer.write({ type: "text-delta", id: "1", delta });
      }
    })();

    const collected: LanguageModelV4StreamPart[] = [];
    for (let i = 0; i < expectedParts; i += 1) {
      const { value } = await reader.read();
      if (value) {
        collected.push(value);
      }
    }
    await writes;
    await writer.close();
    return collected;
  }

  it("streams text containing <callback> without waiting for finish", async () => {
    const out = await collectWhileOpen(
      ["See the <callback> API here.", " More text."],
      3
    );

    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toContain("<callback> API here.");
    expect(text).toContain("More text.");
  });

  it("streams text containing <toolbar> and <invoker> immediately", async () => {
    const out = await collectWhileOpen(
      ["Use <toolbar> and <invoker> tags."],
      2
    );

    const text = out
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toBe("Use <toolbar> and <invoker> tags.");
  });
});
