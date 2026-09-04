import { describe, expect, it, vi } from "vitest";

import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import type {
  ParserOptions,
  ProtocolMetadata,
} from "../../../../core/protocols/protocol-interface";

type OnError = NonNullable<ParserOptions["onError"]>;

vi.mock("@ai-sdk/provider-utils", () => ({
  generateId: vi.fn(() => "mock-id"),
}));

function requireErrorCall(onError: ReturnType<typeof vi.fn<OnError>>) {
  expect(onError).toHaveBeenCalledTimes(1);
  const [errorCall] = onError.mock.calls;
  if (errorCall === undefined) {
    throw new TypeError("Expected one protocol error call");
  }
  const [message, metadata] = errorCall;
  if (metadata === undefined) {
    throw new TypeError("Expected protocol error metadata");
  }
  return { message, metadata };
}

function expectToolCallId(metadata: ProtocolMetadata): void {
  expect(typeof metadata.toolCallId).toBe("string");
  if (typeof metadata.toolCallId !== "string") {
    throw new TypeError("Expected a protocol tool-call ID");
  }
  expect(metadata.toolCallId.length).toBeGreaterThan(0);
}

describe("protocol error paths", () => {
  const protocol = hermesProtocol();

  it("hermesProtocol parseGeneratedText calls onError and preserves text on bad JSON", () => {
    const onError = vi.fn<OnError>();
    const text = "before <tool_call>{invalid}</tool_call> after";
    const out = protocol.parseGeneratedText({
      text,
      tools: [],
      options: { onError },
    });
    expect(onError).toHaveBeenCalled();
    const rejoined = out
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    expect(rejoined).toContain("<tool_call>{invalid}</tool_call>");
  });

  it("hermesProtocol parseGeneratedText onError metadata includes toolName, toolCallId, and malformed-tool-call-body dropReason", () => {
    const onError = vi.fn<OnError>();
    protocol.parseGeneratedText({
      text: '<tool_call>{"name":"bash","arguments": not valid json here}</tool_call>',
      tools: [],
      options: { onError },
    });
    const { message, metadata } = requireErrorCall(onError);
    expect(message).toContain("Could not process JSON tool call");
    expect(metadata).toMatchObject({
      toolName: "bash",
      dropReason: "malformed-tool-call-body",
    });
    expect(typeof metadata.toolCall).toBe("string");
    if (typeof metadata.toolCall !== "string") {
      throw new TypeError("Expected tool-call metadata text");
    }
    expect(metadata.toolCall).toContain("<tool_call>");
    expectToolCallId(metadata);
  });

  it("hermesProtocol parseGeneratedText onError leaves toolName undefined when name is missing but still populates toolCallId and dropReason", () => {
    const onError = vi.fn<OnError>();
    protocol.parseGeneratedText({
      text: "<tool_call>{not even a name key}</tool_call>",
      tools: [],
      options: { onError },
    });
    const { metadata } = requireErrorCall(onError);
    expect(metadata).toMatchObject({
      dropReason: "malformed-tool-call-body",
    });
    expect(metadata.toolName).toBeUndefined();
    expectToolCallId(metadata);
  });
});
