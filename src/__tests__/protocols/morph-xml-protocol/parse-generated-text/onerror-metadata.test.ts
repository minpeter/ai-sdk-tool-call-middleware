import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "write_file",
    description: "Write content to a file",
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

describe("morphXmlProtocol parseGeneratedText onError metadata", () => {
  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when XML body parse fails", () => {
    const onError = vi.fn();
    const protocol = morphXmlProtocol();
    const text =
      "<write_file><file_path>a</file_path><file_path>b</file_path></write_file>";
    protocol.parseGeneratedText({ text, tools, options: { onError } });

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not process XML tool call")
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
});
