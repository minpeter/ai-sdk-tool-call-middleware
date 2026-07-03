import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  createChunkedStream,
  pipeWithTransformer,
} from "../../../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "book_flight",
    inputSchema: {
      type: "object",
      properties: {
        passenger: { type: "object" },
        legs: { type: "array" },
        cabin: { type: "string" },
      },
    },
  },
];

// Real-world shape observed from LiquidAI LFM2: a Hermes-style JSON payload
// inside <tool_call> tags while the Qwen3-Coder prompt is active.
const HERMES_JSON_UNDER_QWEN = `<tool_call>
{"name": "book_flight", "arguments": {"passenger": {"name": "Jane Doe", "age": 34}, "legs": [{"from": "ICN", "to": "NRT"}], "cabin": "economy"}}
</tool_call>`;

describe("qwen3CoderProtocol foreign-format salvage", () => {
  it("salvages a Hermes-style JSON payload inside tool_call tags (stream)", async () => {
    const p = qwen3CoderProtocol();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream(HERMES_JSON_UNDER_QWEN),
        p.createStreamParser({ tools })
      )
    );

    const call = out.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new Error("Expected tool-call part");
    }
    expect(call.toolName).toBe("book_flight");
    const input = JSON.parse(call.input);
    expect(input.passenger).toEqual({ name: "Jane Doe", age: 34 });
    expect(input.legs).toEqual([{ from: "ICN", to: "NRT" }]);

    const text = out
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta)
      .join("");
    expect(text).toBe("");
  });

  it("still drops prose-only tool_call blocks with onError", async () => {
    const errors: string[] = [];
    const p = qwen3CoderProtocol();
    const out = await convertReadableStreamToArray(
      pipeWithTransformer(
        createChunkedStream("<tool_call>\nsome prose, not a call\n"),
        p.createStreamParser({
          tools,
          options: { onError: (m) => errors.push(m) },
        })
      )
    );

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
