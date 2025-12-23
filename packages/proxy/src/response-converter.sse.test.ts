import { describe, expect, it } from "vitest";
import {
  createOpenAIStreamConverter,
  createSSEResponse,
} from "./response-converter.js";

interface Parsed {
  id?: string;
  choices: Array<{ delta?: Record<string, unknown>; finish_reason?: string }>;
}

function parseLine(line: string): Parsed | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  try {
    return JSON.parse(trimmed.slice(5).trim()) as Parsed;
  } catch {
    return;
  }
}

describe("SSE formatting via createSSEResponse", () => {
  it("produces SSE data frames with reasoning/content and finish", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");
    const out = [
      ...convert({ type: "start" }),
      ...convert({ type: "reasoning-delta", text: "thinking" }),
      ...convert({ type: "text-delta", text: "answer" }),
      ...convert({ type: "finish-step", finishReason: "stop" }),
    ];

    const sse = createSSEResponse(out);
    const frames = sse.split("\n\n").filter(Boolean);
    const parsed = frames.map(parseLine).filter(Boolean) as Parsed[];

    const uniqueIds = new Set(parsed.map((p) => p.id));
    expect(uniqueIds.size).toBe(1);

    const reasoning = parsed.find(
      (p) => p.choices?.[0]?.delta?.reasoning_content
    );
    expect((reasoning?.choices?.[0]?.delta as any)?.reasoning_content).toBe(
      "thinking"
    );

    const content = parsed.find((p) => p.choices?.[0]?.delta?.content);
    expect((content?.choices?.[0]?.delta as any)?.content).toBe("answer");

    const reasons = parsed
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));
    expect(reasons).toEqual(["stop"]);
  });

  it("emits tool_calls delta and finish_reason tool_calls when tool-call occurs", () => {
    const convert = createOpenAIStreamConverter("wrapped-model");
    const out = [
      ...convert({ type: "start" }),
      ...convert({
        type: "tool-call",
        toolCallId: "1",
        toolName: "get_weather",
        input: { city: "Seoul" },
      }),
      ...convert({ type: "finish-step", finishReason: "stop" }),
    ];

    const sse = createSSEResponse(out);
    const frames = sse.split("\n\n").filter(Boolean);
    const parsed = frames.map(parseLine).filter(Boolean) as Parsed[];

    const withToolCall = parsed.find((p) =>
      Array.isArray((p.choices?.[0]?.delta as any)?.tool_calls)
    );
    const toolCalls = (withToolCall?.choices?.[0]?.delta as any)?.tool_calls as
      | Array<{ function?: { name?: string; arguments?: string } }>
      | undefined;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls?.[0]?.function?.name).toBe("get_weather");

    const reasons = parsed
      .map((p) => p.choices?.[0]?.finish_reason)
      .filter((r): r is string => Boolean(r));
    expect(reasons).toEqual(["tool_calls"]);
  });
});
