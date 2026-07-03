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

describe("qwen3CoderProtocol trailing partial after invalid full occurrence", () => {
  it("holds a genuine trailing partial even when <tool_callback> appears earlier", async () => {
    const parser = qwen3CoderProtocol().createStreamParser({
      tools: emptyFunctionTools,
    });
    const writer = parser.writable.getWriter();
    const reader = parser.readable.getReader();

    const writes = (async () => {
      await writer.write({
        type: "text-delta",
        id: "1",
        delta: "docs at <tool_callback> page. <tool_ca",
      });
      await writer.write({
        type: "text-delta",
        id: "1",
        delta:
          "ll>\n<function=get_weather>\n<parameter=city>Seoul</parameter>\n</function>\n</tool_call>",
      });
    })();

    const collected: LanguageModelV4StreamPart[] = [];
    while (collected.filter((p) => p.type === "tool-call").length === 0) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        collected.push(value);
      }
    }
    await writes;
    await writer.close();

    const text = collected
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    // The prose before the call streams out; the tag itself must not leak.
    expect(text).toContain("<tool_callback> page.");
    expect(text).not.toContain("<tool_call>");

    const call = collected.find((p) => p.type === "tool-call") as Extract<
      LanguageModelV4StreamPart,
      { type: "tool-call" }
    >;
    expect(call).toBeDefined();
    expect(JSON.parse(call.input)).toEqual({ city: "Seoul" });
  });
});
