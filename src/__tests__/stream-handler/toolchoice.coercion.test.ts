import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";

import { toolChoiceStream } from "../../stream-handler";

describe("toolChoiceStream coercion", () => {
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
});
