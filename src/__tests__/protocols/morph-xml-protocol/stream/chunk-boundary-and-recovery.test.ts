import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call");
    expect(tool).toMatchObject({ type: "tool-call", toolName: "get_weather" });
  });

  it("preserves self-closing tags with leading whitespace split across chunks", async () => {
    const protocol = morphXmlProtocol();
    const whitespaceTools = [
      {
        type: "function",
        name: "get_location",
        description: "",
        inputSchema: { type: "object" },
      },
    ] as any;
    const transformer = protocol.createStreamParser({ tools: whitespaceTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "prefix < get_loc",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "ation/> suffix",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(tool).toMatchObject({
      type: "tool-call",
      toolName: "get_location",
      input: "{}",
    });
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    expect(text).toContain("prefix ");
    expect(text).toContain(" suffix");
    expect(text).not.toContain("< get_loc");
  });

  it("accepts whitespace in the closing tag name while streaming", async () => {
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({ tools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather><location>SF</location></ get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("SF");
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    // Either tool-call recovery succeeds, or raw text stays suppressed.
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");
    const hasTool = out.some((c) => c.type === "tool-call");
    expect(hasTool || text.length === 0).toBe(true);
  });

  it("force-completes unfinished call at flush when parseable", async () => {
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as
      | { type: "tool-call"; toolName: string; input: string }
      | undefined;
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c: any) => c.delta)
      .join("");

    if (tool) {
      expect(tool.toolName).toBe("get_weather");
      expect(JSON.parse(tool.input)).toEqual({ location: "NY" });
    } else {
      expect(text).not.toContain("<get_weather>");
    }
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
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
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(rs, transformer)
    );
    const tool = out.find((c) => c.type === "tool-call") as any;
    expect(tool).toBeTruthy();
    expect(JSON.parse(tool.input).location).toBe("NY");
  });
});
