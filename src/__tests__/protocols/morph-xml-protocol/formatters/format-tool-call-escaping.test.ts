import type {
  LanguageModelV4ToolCall,
  LanguageModelV4ToolCallPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

type ObjectInputToolCall = LanguageModelV4ToolCallPart & {
  input: { a: number; b: number };
};

type FormatterToolCallFixture = LanguageModelV4ToolCall & ObjectInputToolCall;

const ADD_TAG_REGEX = /<add>/;
const A_TAG_REGEX = /<a>1<\/a>/;

describe("morphXmlProtocol formatters", () => {
  it("formatToolCall handles JSON string input and object input", () => {
    const p = morphXmlProtocol();
    const asString = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: JSON.stringify({ a: 1, b: 2 }),
    });
    expect(asString).toMatch(ADD_TAG_REGEX);
    expect(asString).toMatch(A_TAG_REGEX);

    const objectInputCall = {
      type: "tool-call",
      toolCallId: "id",
      toolName: "add",
      input: { a: 1, b: 2 },
    } satisfies ObjectInputToolCall;
    const asObject = p.formatToolCall(
      objectInputCall as FormatterToolCallFixture
    );
    expect(asObject).toMatch(ADD_TAG_REGEX);
  });

  it("formatToolCall outputs formatted XML with newlines and indentation", () => {
    const p = morphXmlProtocol();
    const result = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "shell_execute",
      input: JSON.stringify({ command: "echo hello" }),
    });

    // Should have newlines (formatted)
    expect(result).toContain("\n");
    // Should have indentation
    expect(result).toContain("  <command>");
    // Expected structure
    expect(result).toBe(
      "<shell_execute>\n  <command>echo hello</command>\n</shell_execute>"
    );
  });

  it("formatToolCall preserves quotes without HTML entity escaping", () => {
    const p = morphXmlProtocol();
    const result = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "shell_execute",
      input: JSON.stringify({ command: 'echo "hello world"' }),
    });

    // Should NOT escape quotes as &quot;
    expect(result).not.toContain("&quot;");
    // Should preserve original quotes
    expect(result).toContain('echo "hello world"');
  });

  it("formatToolCall still escapes required XML characters", () => {
    const p = morphXmlProtocol();
    const result = p.formatToolCall({
      type: "tool-call",
      toolCallId: "id",
      toolName: "shell_execute",
      input: JSON.stringify({ command: "echo <script>&test</script>" }),
    });

    // Should escape < and & (minimalEscaping only escapes < and &, not >)
    expect(result).toContain("&lt;script>");
    expect(result).toContain("&amp;test");
    expect(result).toContain("&lt;/script>");
  });
});
