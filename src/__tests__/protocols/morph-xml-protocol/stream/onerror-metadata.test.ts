import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "write_file",
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["file_path", "contents"],
    },
  },
];

describe("morphXmlProtocol streaming onError metadata", () => {
  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when streaming XML body parse fails", async () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta:
            "<write_file><file_path>a</file_path><file_path>b</file_path></write_file>",
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
      String(message).includes("Could not process streaming XML tool call")
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      toolName: "write_file",
      dropReason: "malformed-tool-call-body",
    });
    expect(typeof metadata?.toolCallId).toBe("string");
    expect((metadata?.toolCallId as string).length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<write_file>");
    expect(metadata?.toolCall).toContain("</write_file>");
  });

  it("drops XML-wrapped YAML-like sensitive fallback without leaking raw text", async () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const pathSentinel = "sentinel-path-secret";
    const contentSentinel = "sentinel-content-secret";
    const transformer = protocol.createStreamParser({
      tools,
      options: { emitRawToolCallTextOnError: true, onError },
    });
    const rs = new ReadableStream<LanguageModelV4StreamPart>({
      start(ctrl) {
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<write_file><file_path>${pathSentinel}</file_path>`,
        });
        ctrl.enqueue({
          type: "text-delta",
          id: "1",
          delta: `<file_path>b</file_path><contents>constructor: true\n"secret": ${contentSentinel}</contents></write_file>`,
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
    const joinedText = out
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    const joinedToolInput = out
      .filter((part) => part.type === "tool-input-delta")
      .map((part) => part.delta)
      .join("");
    const metadataText = JSON.stringify(onError.mock.calls);

    expect(out.some((part) => part.type === "tool-call")).toBe(false);
    expect(joinedText).toBe("");
    expect(joinedToolInput).not.toContain(pathSentinel);
    expect(joinedToolInput).not.toContain(contentSentinel);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(pathSentinel);
    expect(metadataText).not.toContain(contentSentinel);
  });
});
