import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../src/stream-handler";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("toolChoiceStream", () => {
  it("emits tool-call and finish chunks from valid JSON text", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{"x":1}}' }],
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      request: { a: 1 },
      response: { b: 2 },
    });

    const { stream, request, response } = await toolChoiceStream({
      doGenerate,
    });

    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "mock-id",
      toolName: "do",
      input: '{"x":1}',
    });
    expect(chunks[1]).toMatchObject({
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    });
    expect(request).toEqual({ a: 1 });
    expect(response).toEqual({ b: 2 });
  });

  it("falls back to unknown tool and empty args on invalid JSON", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    });

    const { stream } = await toolChoiceStream({ doGenerate });
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

    const { stream } = await toolChoiceStream({ doGenerate });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "unknown",
      input: "{}",
    });
    expect(chunks[1]).toMatchObject({
      type: "finish",
      usage: { totalTokens: 0 },
    });
  });
});
