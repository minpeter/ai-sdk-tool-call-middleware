import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../../stream-handler";
import { mockUsage } from "../test-helpers";

const TOOL_CALL_ID_RE = /^call_[A-Za-z0-9]{24}$/;

describe("toolChoiceStream behavior", () => {
  it("emits the full tool-input lifecycle and finish from valid JSON text", async () => {
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

    expect(chunks.map((c) => c.type)).toEqual([
      "stream-start",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ]);

    expect(chunks[0]).toMatchObject({ type: "stream-start", warnings: [] });
    expect(chunks[1]).toMatchObject({
      type: "tool-input-start",
      toolName: "do",
    });
    expect(chunks[2]).toMatchObject({
      type: "tool-input-delta",
      delta: '{"x":1}',
    });

    const toolCall = chunks[4] as {
      type: string;
      toolCallId: string;
      toolName: string;
      input: string;
    };
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "do",
      input: '{"x":1}',
    });
    expect(toolCall.toolCallId).toMatch(TOOL_CALL_ID_RE);

    // The tool-input lifecycle ids reconcile with the final toolCallId.
    expect((chunks[1] as { id?: string }).id).toBe(toolCall.toolCallId);
    expect((chunks[2] as { id?: string }).id).toBe(toolCall.toolCallId);
    expect((chunks[3] as { id?: string }).id).toBe(toolCall.toolCallId);

    expect(chunks[5]).toMatchObject({
      type: "finish",
      finishReason: {
        unified: "tool-calls",
        raw: "tool-calls",
      },
    });
    expect(request).toEqual({ a: 1 });
    expect(response).toEqual({ b: 2 });
  });

  it("forwards underlying warnings on stream-start", async () => {
    const warnings = [{ type: "unsupported", feature: "seed" }];
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      warnings,
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({ type: "stream-start", warnings });
  });

  it("forwards providerMetadata on the finish part", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      providerMetadata: { someProvider: { traceId: "t1" } },
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      providerMetadata: { someProvider: { traceId: "t1" } },
    });
  });

  it("falls back to unknown tool and empty args on invalid JSON", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "not-json" }],
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    const toolCall = chunks.find((c) => c.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolName: "unknown",
      input: "{}",
    });
    expect((toolCall as { toolCallId?: string }).toolCallId).toMatch(
      TOOL_CALL_ID_RE
    );
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
  });

  it("redacts invalid JSON metadata for prototype-sensitive toolChoice text", async () => {
    const onError = vi.fn();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"do","arguments":{"constructor":{"polluted":true},"x":1',
        },
      ],
    });

    const { stream } = await toolChoiceStream({
      doGenerate,
      tools: [],
      options: { onError },
    });
    await convertReadableStreamToArray(stream);

    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("redacts non-object argument metadata for prototype-sensitive toolChoice args", async () => {
    const onError = vi.fn();
    const doGenerate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"name":"do","arguments":"{\\"constructor\\":{\\"polluted\\":true}}"}',
        },
      ],
    });

    const { stream } = await toolChoiceStream({
      doGenerate,
      tools: [],
      options: { onError },
    });
    await convertReadableStreamToArray(stream);

    expect(onError).toHaveBeenCalledOnce();
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain("constructor");
    expect(metadataText).not.toContain("polluted");
  });

  it("handles empty content by emitting default unknown tool and zeroed usage", async () => {
    const doGenerate = vi.fn().mockResolvedValue({ content: [] });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks.find((c) => c.type === "tool-call")).toMatchObject({
      type: "tool-call",
      toolName: "unknown",
      input: "{}",
    });
    expect(chunks.at(-1)).toMatchObject({
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

  it("preserves string finish reason as raw value", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      finishReason: "length",
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks.at(-1)).toMatchObject({
      type: "finish",
      finishReason: {
        unified: "length",
        raw: "length",
      },
    });
  });
});
