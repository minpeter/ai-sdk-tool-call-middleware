import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";
import { basicTools } from "../parse-generated-text/shared";

describe("yamlXmlProtocol streaming onError metadata", () => {
  const prototypeSensitiveKeys = [
    "__proto__",
    "constructor",
    "prototype",
  ] as const;

  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when streaming YAML body parse fails", async () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
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
    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not parse streaming YAML tool call")
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "malformed-tool-call-body",
    });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    expect((toolCallId as string).length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<get_weather>");
  });

  it.each(
    prototypeSensitiveKeys
  )("redacts malformed XML-wrapped YAML keys for %s", async (key) => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<get_weather>${key}: [</get_weather>`,
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

    expect(
      out
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(key);
    expect(metadataText).not.toContain("<get_weather>");
  });

  it("redacts prototype-sensitive streaming stringify errors in metadata", async () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));

    expect(onError).toHaveBeenCalledTimes(1);
    const metadata = onError.mock.calls[0]?.[1] as
      | { error?: unknown }
      | undefined;
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });

  it("redacts prototype-sensitive streaming finish stringify errors in metadata", async () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n",
        });
        ctrl.enqueue({
          type: "finish",
          finishReason: stopFinishReason,
          usage: zeroUsage,
        });
        ctrl.close();
      },
    });

    await convertReadableStreamToArray(pipeWithTransformer(rs, transformer));

    expect(onError).toHaveBeenCalledTimes(1);
    const metadata = onError.mock.calls[0]?.[1] as
      | { error?: unknown }
      | undefined;
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });
});
