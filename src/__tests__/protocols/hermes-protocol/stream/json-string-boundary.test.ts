import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("hermesProtocol streaming – end tag inside JSON string values", () => {
  it("does not split on </tool_call> inside a JSON string value (single chunk)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            '<tool_call>{"name":"bash","arguments":{"command":"echo \'</tool_call>\' test"}}</tool_call>',
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
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });

    // No tool-call content should leak into text output
    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });

  it("does not split on </tool_call> inside a JSON string value split across chunks", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"bash","arguments":{"command":"echo \'',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "</tool_call>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '\' test"}}</tool_call>',
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
    expect(tool.toolName).toBe("bash");
    expect(JSON.parse(tool.input)).toEqual({
      command: "echo '</tool_call>' test",
    });
  });

  it("still parses normal streaming tool calls correctly (regression check)", async () => {
    const protocol = hermesProtocol();
    const transformer = protocol.createStreamParser({ tools: [] });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "before ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: '<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>',
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: " after",
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
    expect(tool.toolName).toBe("get_weather");
    expect(JSON.parse(tool.input)).toEqual({ city: "NYC" });

    const text = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta)
      .join("");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("</tool_call>");
  });
});
