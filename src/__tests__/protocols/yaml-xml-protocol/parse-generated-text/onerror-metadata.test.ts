import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools } from "./shared";

describe("yamlXmlProtocol parseGeneratedText onError metadata", () => {
  const prototypeSensitiveKeys = [
    "__proto__",
    "constructor",
    "prototype",
  ] as const;

  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when YAML body parse fails", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = "<get_weather>\n[invalid: yaml:\n</get_weather>";
    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { onError },
    });

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not parse YAML tool call")
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

  it("attaches yaml-parse-error cause to the uniform malformed-tool-call-body onError metadata when YAML syntax fails", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = "<get_weather>\n[invalid: yaml:\n</get_weather>";
    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { onError },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(String(message)).toBe("Could not parse YAML tool call");
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "malformed-tool-call-body",
    });
    const { cause } = metadata as { cause?: { kind?: string } };
    expect(cause).toMatchObject({ kind: "yaml-parse-error" });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    expect((toolCallId as string).length).toBeGreaterThan(0);
  });

  it("attaches yaml-non-mapping cause to the uniform malformed-tool-call-body onError metadata when the YAML document is not a mapping", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = "<get_weather>\njust a scalar string\n</get_weather>";
    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { onError },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [message, metadata] = onError.mock.calls[0];
    expect(String(message)).toBe("Could not parse YAML tool call");
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "malformed-tool-call-body",
    });
    const { cause } = metadata as { cause?: { kind?: string } };
    expect(cause).toMatchObject({ kind: "yaml-non-mapping" });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    expect((toolCallId as string).length).toBeGreaterThan(0);
  });

  it.each(
    prototypeSensitiveKeys
  )("redacts malformed XML-wrapped YAML keys for %s", (key) => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = `<get_weather>${key}: [</get_weather>`;

    const out = protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(
      out
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    ).toBe("");
    expect(onError).toHaveBeenCalledTimes(1);
    const metadataText = JSON.stringify(onError.mock.calls);
    expect(metadataText).toContain("[redacted sensitive tool call]");
    expect(metadataText).not.toContain(key);
    expect(metadataText).not.toContain("<get_weather>");
  });

  it("redacts prototype-sensitive stringify errors in metadata", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text =
      "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>";

    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { emitRawToolCallTextOnError: true, onError },
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const metadata = onError.mock.calls[0]?.[1] as
      | { error?: unknown }
      | undefined;
    expect(metadata?.error).toBe("[redacted sensitive tool call]");
  });
});
