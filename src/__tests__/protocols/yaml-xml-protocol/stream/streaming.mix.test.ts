import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming text and tool mixing", () => {
  it("should emit text before and after tool call", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "Checking weather ",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather>\nlocation: Sydney\n</get_weather>",
        });
        ctrl.enqueue({ type: "text-delta", id: "1", delta: " Done!" });
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
    const toolCalls = out.filter((c) => c.type === "tool-call");
    const textDeltas = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");

    expect(toolCalls).toHaveLength(1);
    expect(textDeltas).toContain("Checking weather");
    expect(textDeltas).toContain("Done!");
    expect(textDeltas).not.toContain("<get_weather>");
  });

  it("should handle multiple tool calls in stream", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_location/>",
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather>\nlocation: Tokyo\n</get_weather>",
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
    const toolCalls = out.filter((c) => c.type === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0] as { toolName: string }).toolName).toBe(
      "get_location"
    );
    expect((toolCalls[1] as { toolName: string }).toolName).toBe("get_weather");
  });

  it("should parse trailing self-closing tags after another tool call in the same chunk", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<get_weather>
location: Madrid
</get_weather><get_location/>`,
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
    const toolCalls = out.filter((c) => c.type === "tool-call") as {
      toolName: string;
      input: string;
    }[];

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].input)).toMatchObject({
      location: "Madrid",
    });
    expect(toolCalls[1]).toMatchObject({
      toolName: "get_location",
      input: "{}",
    });
  });
});
