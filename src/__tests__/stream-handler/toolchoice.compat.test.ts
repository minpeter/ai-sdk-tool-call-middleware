import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../../stream-handler";
import { mockFinishReason, mockUsage } from "../test-helpers";

describe("toolChoiceStream compat", () => {
  it("works when called without tools for backwards compatibility", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{"x":1}}' }],
    });

    const { stream } = await toolChoiceStream({ doGenerate });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[0]).toMatchObject({
      type: "tool-call",
      toolName: "do",
      input: '{"x":1}',
    });
    expect(chunks[1]).toMatchObject({ type: "finish" });
  });

  it("normalizes finish reason to tool-calls and preserves legacy object reason", async () => {
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
        raw: "stop",
      },
    });
  });

  it("converts legacy numeric usage shape instead of zeroing usage", async () => {
    const doGenerate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: '{"name":"do","arguments":{}}' }],
      usage: { inputTokens: 7, outputTokens: 11 },
    });

    const { stream } = await toolChoiceStream({ doGenerate, tools: [] });
    const chunks = await convertReadableStreamToArray(stream);

    expect(chunks[1]).toMatchObject({
      type: "finish",
      usage: mockUsage(7, 11),
    });
  });
});
