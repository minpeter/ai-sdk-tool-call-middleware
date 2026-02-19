import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

describe("morphXmlProtocol streaming error policy", () => {
  it("suppresses raw XML tags in output when parsing fails by default", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "bad_tool",
        description: "Tool with strict schema",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    ];
    const onError = vi.fn();
    const transformer = protocol.createStreamParser({
      tools,
      options: { onError },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Calling tool:\n" });
        // Invalid XML with duplicate string tags (will cause RXMLDuplicateStringTagError)
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<bad_tool><name>first</name><name>second</name></bad_tool>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nDone!" });
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
    const textParts = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as any).delta);
    const fullText = textParts.join("");

    // Verify no tool call was created due to error
    expect(toolCalls).toHaveLength(0);

    // Verify onError was called
    expect(onError).toHaveBeenCalled();

    // Verify malformed tool XML is not leaked in text fallback by default
    expect(fullText).not.toContain("<bad_tool>");
    expect(fullText).not.toContain("</bad_tool>");
    expect(fullText).not.toContain("<name>");

    // Verify surrounding text is also present
    expect(fullText).toContain("Calling tool:");
    expect(fullText).toContain("Done!");
  });

  it("can expose raw XML fallback when explicitly enabled", async () => {
    const protocol = morphXmlProtocol();
    const tools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "bad_tool",
        description: "Tool with strict schema",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
    ];
    const transformer = protocol.createStreamParser({
      tools,
      options: { emitRawToolCallTextOnError: true },
    });
    const rs = new ReadableStream<LanguageModelV3StreamPart>({
      start(ctrl) {
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "Calling tool:\n" });
        ctrl.enqueue({
          type: "text-delta",
          id: "t",
          delta: "<bad_tool><name>first</name><name>second</name></bad_tool>",
        });
        ctrl.enqueue({ type: "text-delta", id: "t", delta: "\nDone!" });
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
    const fullText = out
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");

    expect(fullText).toContain("<bad_tool>");
    expect(fullText).toContain("</bad_tool>");
    expect(fullText).toContain("<name>");
    expect(fullText).toContain("Calling tool:");
    expect(fullText).toContain("Done!");
  });
});
