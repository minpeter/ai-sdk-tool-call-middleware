import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming error policy", () => {
  it("should suppress raw tool markup on YAML parse error by default", async () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather>\n[invalid: yaml:\n</get_weather>",
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
    const textDeltas = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");

    expect(textDeltas).not.toContain("<get_weather>");
    expect(textDeltas).not.toContain("</get_weather>");
    expect(onError).toHaveBeenCalled();
  });

  it("should allow raw fallback text when explicitly enabled", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather>\n[invalid: yaml:\n</get_weather>",
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
    const textDeltas = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");

    expect(textDeltas).toContain("<get_weather>");
    expect(textDeltas).toContain("</get_weather>");
  });

  it("should force-complete incomplete tool call on finish when parseable", async () => {
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({ tools: basicTools });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: "<get_weather>\nlocation: Incomplete",
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
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0] as { toolName: string }).toolName).toBe("get_weather");
    const args = JSON.parse((toolCalls[0] as { input: string }).input);
    expect(args).toEqual({
      location: "Incomplete",
    });
  });
});
