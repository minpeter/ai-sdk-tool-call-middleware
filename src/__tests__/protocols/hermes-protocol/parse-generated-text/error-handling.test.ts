import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

describe("protocol error paths", () => {
  it("hermesProtocol parseGeneratedText calls onError and preserves text on bad JSON", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = "before <tool_call>{invalid}</tool_call> after";
    const out = p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((x) => (x.type === "text" ? (x as any).text : ""))
      .join("");
    expect(rejoined).toContain("<tool_call>{invalid}</tool_call>");
  });

  it("hermesProtocol parseGeneratedText onError metadata includes toolName, toolCallId, and malformed-tool-call-body dropReason", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text =
      '<tool_call>{"name":"bash","arguments": not valid json here}</tool_call>';
    p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(message).toContain("Could not process JSON tool call");
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "malformed-tool-call-body",
    });
    expect(typeof metadata.toolCall).toBe("string");
    expect(metadata.toolCall).toContain("<tool_call>");
    expect(typeof metadata.toolCallId).toBe("string");
    expect((metadata.toolCallId as string).length).toBeGreaterThan(0);
  });

  it("hermesProtocol parseGeneratedText onError leaves toolName undefined when name is missing but still populates toolCallId and dropReason", () => {
    const onError = vi.fn();
    const p = hermesProtocol();
    const text = "<tool_call>{not even a name key}</tool_call>";
    p.parseGeneratedText({ text, tools: [], options: { onError } });
    expect(onError).toHaveBeenCalledTimes(1);
    const [, metadata] = onError.mock.calls[0];
    expect(metadata).toMatchObject({
      dropReason: "malformed-tool-call-body",
    });
    expect(metadata.toolName).toBeUndefined();
    expect(typeof metadata.toolCallId).toBe("string");
    expect((metadata.toolCallId as string).length).toBeGreaterThan(0);
  });
});
