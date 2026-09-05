import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

const badTool: LanguageModelV4FunctionTool = {
  type: "function",
  name: "bad_tool",
  description: "Tool with strict schema",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
};

const malformedChunks = [
  "Calling tool:\n",
  "<bad_tool><name>first</name><name>second</name></bad_tool>",
  "\nDone!",
];

describe("morphXmlProtocol streaming error policy", () => {
  it("suppresses raw XML tags in output when parsing fails by default", async () => {
    const onError = vi.fn();
    const out = await runProtocolTextStream({
      chunks: malformedChunks,
      id: "morph-error-suppressed",
      parserOptions: { onError },
      protocol: morphXmlProtocol(),
      tools: [badTool],
    });
    const fullText = collectTextDeltas(out);
    expect(selectToolCalls(out)).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
    for (const hidden of ["<bad_tool>", "</bad_tool>", "<name>"]) {
      expect(fullText).not.toContain(hidden);
    }
    expect(fullText).toContain("Calling tool:");
    expect(fullText).toContain("Done!");
  });

  it("can expose raw XML fallback when explicitly enabled", async () => {
    const out = await runProtocolTextStream({
      chunks: malformedChunks,
      id: "morph-error-raw",
      parserOptions: { emitRawToolCallTextOnError: true },
      protocol: morphXmlProtocol(),
      tools: [badTool],
    });
    const fullText = collectTextDeltas(out);
    for (const visible of [
      "<bad_tool>",
      "</bad_tool>",
      "<name>",
      "Calling tool:",
      "Done!",
    ]) {
      expect(fullText).toContain(visible);
    }
  });
});
