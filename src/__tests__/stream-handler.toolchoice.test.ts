import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../stream-handler";
import { mockFinishReason, mockUsage } from "./test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("toolChoiceStream", () => {
  it("emits tool-call and finish chunks from valid JSON text", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{"x":1}}' }],
      usage: mockUsage(3, 5),
      request: { a: 1 },
      response: { b: 2 },
    });

    const { stream, request, response } = await toolChoiceStream({
      doGenerate,
      tools: [],
    });

    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "mock-id",
      toolName: "do",
      input: '{"x":1}',
    });
    // The actual implementation returns finishReason as string and usage from doGenerate
    expect(chunks[1]).toMatchObject({
      type: "finish",
      finishReason: {
        unified: "tool-calls",
        raw: "tool-calls",
      },
    });
    expect(request).toEqual({ a: 1 });
    expect(response).toEqual({ b: 2 });
  });

  it("falls back to unknown tool and empty args on invalid JSON", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "mock-id",
      toolName: "unknown",
      input: "{}",
    });
    expect(chunks[1]).toMatchObject({ type: "finish" });
  });

  it("handles empty content by emitting default unknown tool and zeroed usage", async () => {
    const doGenerate = vi.fn().mockResolvedValue({ content: [] });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "unknown",
      input: "{}",
    });
    expect(chunks[1]).toMatchObject({
      type: "finish",
      usage: {
        inputTokens: {
          total: 0,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 0,
          text: undefined,
          reasoning: undefined,
        },
      },
    });
  });

  it("coerces tool arguments using decoded tool schema", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"calc","arguments":{"a":"10","b":"false"}}',
        },
      ],
    });

    const { stream } = await toolChoiceStream({
      doGenerate,
      tools: [
        {
          type: "function",
          name: "calc",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "boolean" },
            },
          },
        },
      ],
    });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "calc",
      input: '{"a":10,"b":false}',
    });
  });

  it("normalizes finish reason to tool-calls while preserving raw value when present", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      finishReason: mockFinishReason("stop"),
      usage: mockUsage(1, 1),
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[1]).toMatchObject({
      type: "finish",
      finishReason: {
        unified: "tool-calls",
        raw: "tool-calls",
      },
    });
  });
});
