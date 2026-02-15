import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { jsonProtocol } from "../../core/protocols/json-protocol";
import { qwen3coder_tool_parser } from "../../core/protocols/qwen3coder-tool-parser-xml-protocol";
import { xmlProtocol } from "../../core/protocols/xml-protocol";
import { yamlProtocol } from "../../core/protocols/yaml-protocol";
import { toolInputStreamFixtures } from "../fixtures/tool-input-stream-fixtures";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../test-helpers";

function createTextDeltaStream(chunks: string[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue({
          type: "text-delta",
          id: "fixture",
          delta: chunk,
        });
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function createInterleavedStream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function extractToolInputTimeline(parts: LanguageModelV3StreamPart[]) {
  const starts = parts.filter(
    (part) => part.type === "tool-input-start"
  ) as Array<{
    type: "tool-input-start";
    id: string;
    toolName: string;
  }>;
  const deltas = parts.filter(
    (part) => part.type === "tool-input-delta"
  ) as Array<{
    type: "tool-input-delta";
    id: string;
    delta: string;
  }>;
  const ends = parts.filter((part) => part.type === "tool-input-end") as Array<{
    type: "tool-input-end";
    id: string;
  }>;
  return { starts, deltas, ends };
}

describe("tool-input streaming events", () => {
  it("json protocol emits tool-input-start/delta/end and reconciles id with tool-call", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol force-completes tool input at finish when closing tag is missing", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
  });

  it("json finish reconciliation does not leak partial end-tag text when recovery succeeds", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          '<tool_call>{"name":"get_weather","arguments":{"location":"Busan","unit":"celsius"}}',
          "</tool_",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("<tool_call>");
    expect(leakedText).not.toContain("</tool_");
  });

  it("json protocol normalizes streamed arguments:null progress to match final tool-call input", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          '<tool_call>{"name":"get_weather","arguments":null',
          "}</tool_call>",
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol does not emit non-canonical partial literal prefixes for split null arguments", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          '<tool_call>{"name":"get_weather","arguments":n',
          "ull}</tool_call>",
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol canonicalizes pretty-printed arguments progress before emitting deltas", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          '<tool_call>{"name":"get_weather","arguments":{\n  "location": "Seoul",',
          '\n  "unit": "celsius"\n}}</tool_call>',
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta)).toEqual([
      '{"location":"Seoul","unit":"celsius"}',
    ]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("json protocol emits tool-input deltas for parseable arguments even when outer JSON is incomplete", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          '<tool_call>{"meta":{"msg":"{"},"name":"get_weather","arguments":{"location":"Seoul","unit":"celsius"}',
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(
      '{"location":"Seoul","unit":"celsius"}'
    );
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(leakedText).not.toContain("<tool_call>");
  });

  it("xml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol emits progress deltas for union-typed object schemas", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const unionWeatherTool: LanguageModelV3FunctionTool = {
      type: "function",
      name: "get_weather",
      description: "Get weather information",
      inputSchema: {
        type: ["object", "null"],
        properties: {
          location: { type: "string" },
          unit: { type: "string" },
        },
        required: ["location"],
      },
    };

    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: [unionWeatherTool],
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("xml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe(fixture.expectedFinishInput);
  });

  it("xml finish reconciliation rejects unclosed payloads with trailing plain text", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather><location>Seoul</location> done"]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml finish reconciliation rejects unclosed payloads with tagless plain text body", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<get_weather>hello"]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(out.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("xml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createInterleavedStream([
          {
            type: "text-delta",
            id: "fixture",
            delta: "<get_weather>\n<location>Seo",
          },
          {
            type: "tool-call",
            toolCallId: "passthrough-xml",
            toolName: "passthrough_marker",
            input: "{}",
          } satisfies LanguageModelV3StreamPart,
          {
            type: "text-delta",
            id: "fixture",
            delta: "ul</location>\n<unit>celsius</unit>\n</get_weather>",
          },
        ]),
        transformer
      )
    );

    const parsedCalls = out.filter(
      (part) => part.type === "tool-call" && part.toolName === "get_weather"
    ) as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0].input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("yaml protocol streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.progressiveChunks),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta)).toEqual(
      fixture.expectedProgressDeltas
    );
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser streams tool input deltas and emits matching tool-call id", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "Before ",
          "<tool_call>\n  <function=get_weather>\n    <parameter=location>Seo",
          "ul</parameter>\n    <parameter=unit>celsius</parameter>\n  </function>\n</tool_call>",
          " After",
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].toolName).toBe("get_weather");
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(toolCall.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
    expect(deltas.some((delta) => delta.delta.includes("<"))).toBe(false);
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<tool_call");
    expect(leakedText).not.toContain("</tool_call");
  });

  it("Qwen3CoderToolParser preserves non-contiguous repeated parameters in streams", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call>\n  <function=alpha>\n    <parameter=a>1</parameter>\n    <parameter=b>2</parameter>\n    <parameter=a>3</parameter>\n  </function>\n</tool_call>",
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("alpha");
    expect(JSON.parse(toolCall.input)).toEqual({ a: ["1", "3"], b: "2" });
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("Qwen3CoderToolParser streams tool calls when <tool_call> wrapper is missing", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "Before ",
          "<function=get_weather><parameter=location>Seoul</parameter><parameter=unit>celsius</parameter></function>",
          " After",
        ]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: string;
        }
      | undefined;

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(starts[0].id).toBe(ends[0].id);
    expect(toolCall?.toolCallId).toBe(starts[0].id);
    expect(toolCall?.toolName).toBe("get_weather");
    expect(toolCall?.input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall?.input);
    expect(leakedText).toContain("Before");
    expect(leakedText).toContain("After");
    expect(leakedText).not.toContain("<function");
    expect(leakedText).not.toContain("</function");
  });

  it("Qwen3CoderToolParser ignores stray </tool_call> before an implicit <function> call", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "</tool_call>\n",
          "<function=alpha><parameter=x>1</parameter></function>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ x: "1" });
    expect(leakedText).not.toContain("</tool_call>");
  });

  it("Qwen3CoderToolParser recovers missing </parameter> during streaming by using next-tag boundary", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call><function=alpha><parameter=a>1<parameter=b>2</parameter></function></tool_call>",
        ]),
        transformer
      )
    );

    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolName: string;
          input: string;
        }
      | undefined;

    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe("alpha");
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({ a: "1", b: "2" });
  });

  it("Qwen3CoderToolParser supports multiple function calls inside a single <tool_call> block in-order", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "prefix ",
          "<tool_call>\n  <function=alpha>\n    <parameter=x>1</parameter>\n  </function>\n  <function=beta>\n    <parameter=y> 2 </parameter>\n    <parameter=y>3</parameter>\n  </function>\n</tool_call>",
          " suffix",
        ]),
        transformer
      )
    );

    const toolCalls = out.filter((part) => part.type === "tool-call") as Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    }>;

    const { starts, deltas, ends } = extractToolInputTimeline(out);

    expect(toolCalls.map((c) => c.toolName)).toEqual(["alpha", "beta"]);
    expect(JSON.parse(toolCalls[0].input)).toEqual({ x: "1" });
    expect(JSON.parse(toolCalls[1].input)).toEqual({ y: ["2", "3"] });

    for (const toolCall of toolCalls) {
      const start = starts.find((s) => s.id === toolCall.toolCallId);
      const end = ends.find((e) => e.id === toolCall.toolCallId);
      const joined = deltas
        .filter((d) => d.id === toolCall.toolCallId)
        .map((d) => d.delta)
        .join("");

      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(joined).toBe(toolCall.input);
    }
  });

  it("Qwen3CoderToolParser force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<tool_call>\n  <function=get_weather>\n    <parameter=location>Busan</parameter>\n    <parameter=unit>celsius</parameter>\n",
        ]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: string;
    };
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.toolName).toBe("get_weather");
    expect(JSON.parse(toolCall.input)).toEqual({
      location: "Busan",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("<tool_call");
  });

  it("Qwen3CoderToolParser flushes buffered partial tool_call at finish as text when enabled", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({
      tools: [],
      options: { emitRawToolCallTextOnError: true },
    });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<tool_call><function=get_weather"]),
        transformer
      )
    );

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-delta")).toBe(false);
    expect(out.some((part) => part.type === "tool-input-end")).toBe(false);
    expect(leakedText).toContain("<tool_call");
    expect(leakedText).toContain("<function=get_weather");
  });

  it("Qwen3CoderToolParser suppresses buffered partial tool_call at finish by default", async () => {
    const protocol = qwen3coder_tool_parser();
    const transformer = protocol.createStreamParser({ tools: [] });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["<tool_call><function=get_weather"]),
        transformer
      )
    );

    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(leakedText).not.toContain("<tool_call");
  });

  it("yaml protocol emits '{}' tool-input-delta for self-closing tags", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(["Before ", "<get_weather/>", " After"]),
        transformer
      )
    );

    const { starts, deltas, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe("{}");
    expect(deltas.map((delta) => delta.delta)).toEqual(["{}"]);
    expect(deltas.map((delta) => delta.delta).join("")).toBe(toolCall.input);
  });

  it("yaml protocol force-completes unclosed tool block at finish when content is parseable", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.finishReconcileChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as {
      type: "tool-call";
      toolCallId: string;
      input: string;
    };

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall.toolCallId).toBe(starts[0].id);
    expect(toolCall.input).toBe(fixture.expectedFinishInput);
  });

  it("yaml finish reconciliation ignores trailing partial close-tag and still emits tool-call", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream([
          "<get_weather>\nlocation: Seoul\nunit: celsius\n</get_wea",
        ]),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const toolCall = out.find((part) => part.type === "tool-call") as
      | {
          type: "tool-call";
          toolCallId: string;
          input: string;
        }
      | undefined;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolCallId).toBe(starts[0].id);
    expect(JSON.parse(toolCall?.input ?? "{}")).toEqual({
      location: "Seoul",
      unit: "celsius",
    });
    expect(leakedText).not.toContain("</get_wea");
  });

  it("yaml protocol does not prematurely finalize tool call when non-text chunks are interleaved", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createInterleavedStream([
          {
            type: "text-delta",
            id: "fixture",
            delta: "<get_weather>\nlocation: Seo",
          },
          {
            type: "tool-call",
            toolCallId: "passthrough-yaml",
            toolName: "passthrough_marker",
            input: "{}",
          } satisfies LanguageModelV3StreamPart,
          {
            type: "text-delta",
            id: "fixture",
            delta: "ul\nunit: celsius\n</get_weather>",
          },
        ]),
        transformer
      )
    );

    const parsedCalls = out.filter(
      (part) => part.type === "tool-call" && part.toolName === "get_weather"
    ) as Array<{
      type: "tool-call";
      toolName: string;
      input: string;
    }>;
    const leakedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");

    expect(parsedCalls).toHaveLength(1);
    expect(parsedCalls[0].input).toBe('{"location":"Seoul","unit":"celsius"}');
    expect(leakedText).not.toContain("<get_weather>");
    expect(leakedText).not.toContain("</get_weather>");
  });

  it("json malformed fixture does not leave dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.json;
    const protocol = jsonProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });

  it("xml malformed fixture does not leave dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.xml;
    const protocol = xmlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    expect(starts.length).toBe(ends.length);
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });

  it("yaml malformed fixture stays non-leaking without dangling tool-input stream", async () => {
    const fixture = toolInputStreamFixtures.yaml;
    const protocol = yamlProtocol();
    const transformer = protocol.createStreamParser({ tools: fixture.tools });
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createTextDeltaStream(fixture.malformedChunks),
        transformer
      )
    );

    const { starts, ends } = extractToolInputTimeline(out);
    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(starts.length).toBe(ends.length);
    expect(text).not.toContain("<get_weather>");
    expect(out.some((part) => part.type === "finish")).toBe(true);
  });
});
