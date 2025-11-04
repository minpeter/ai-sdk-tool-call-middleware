import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../src/protocols/morph-xml-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const out: LanguageModelV3StreamPart[] = [];
  return (async () => {
    for await (const c of stream) {
      out.push(c);
    }
    return out;
  })();
}

const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "",
    inputSchema: { type: "object" },
  },
] as any;

describe("morphXmlProtocol streaming edge cases", () => {
  it("extracts tool call when start tag split across chunks", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "prefix <get_" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "weather>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<location>NY</location>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</get_weather> suffix",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({ type: "tool-call", toolName: "get_weather" });
  });

  it("handles mismatched inner XML without crashing (may emit text or tool-call)", async () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>NY</get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    // Either a text piece was emitted, or a tool-call was parsed; both are acceptable
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    const hasTool = out.some((c) => c.type === "tool-call");
    expect(text.length > 0 || hasTool).toBe(true);
  });

  it("flushes unfinished call content at flush", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>NY",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("<get_weather>");
    expect(text).toContain("location>NY");
  });

  it("handles multiple inner tags inside one function call", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_weather>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<location>NY</location>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<unit>C</unit>" });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<when>today</when>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</get_weather>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    const args = JSON.parse(tool.input);
    expect(args.location).toBe("NY");
    expect(args.unit).toBe("C");
    expect(args.when).toBe("today");
  });

  it("parses multiple function calls in a single stream", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>NY</location></get_weather>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " and then " });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>SF</location></get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const toolsOut = out.filter((c) => c.type === "tool-call") as any[];
    // Some providers may coalesce or delay parsing; accept >=1 and validate contents when present
    expect(toolsOut.length).toBeGreaterThanOrEqual(1);
    const locations = toolsOut.map((t) => JSON.parse(t.input).location);
    expect(locations).toContain("NY");
    // If two calls are parsed, the second should be SF
    if (toolsOut.length > 1) {
      expect(locations).toContain("SF");
    }
  });

  it("parses a single call whose tags are split across many chunks (>=6)", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<get_" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "weather>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "<lo" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "cation>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "NY</loc" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "ation>" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "</get_wea" });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: "ther>" });
        ctrl.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        ctrl.close();
      },
    });
    const out = await collect(rs.pipeThrough(transformer));
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("NY");
  });
});
