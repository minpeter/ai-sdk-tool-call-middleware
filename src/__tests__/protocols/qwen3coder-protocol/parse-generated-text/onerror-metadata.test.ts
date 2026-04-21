import { describe, expect, it, vi } from "vitest";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";

describe("qwen3CoderProtocol parseGeneratedText onError metadata", () => {
  const tools = emptyFunctionTools;

  it("populates toolCallId and malformed-tool-call-body dropReason when a wrapped <tool_call> segment fails to parse", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const bad =
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>";
    p.parseGeneratedText({
      text: `before ${bad} after`,
      tools,
      options: { onError },
    });

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes(
        "Could not process Qwen3CoderToolParser XML tool call"
      )
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      dropReason: "malformed-tool-call-body",
    });
    expect(typeof metadata?.toolCallId).toBe("string");
    expect((metadata?.toolCallId as string).length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<tool_call>");
  });

  it("salvages toolName from markup when present even if the body is unparseable", () => {
    const onError = vi.fn();
    const p = qwen3CoderProtocol();
    const bad =
      '<tool_call><function="alpha"><parameter type="broken" extra></parameter></function></tool_call>';
    p.parseGeneratedText({
      text: bad,
      tools,
      options: { onError },
    });

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes(
        "Could not process Qwen3CoderToolParser XML tool call"
      )
    );
    if (parseFail) {
      const metadata = parseFail?.[1];
      expect(metadata?.toolName).toBe("alpha");
      expect(metadata?.dropReason).toBe("malformed-tool-call-body");
      expect(typeof metadata?.toolCallId).toBe("string");
    }
  });
});
