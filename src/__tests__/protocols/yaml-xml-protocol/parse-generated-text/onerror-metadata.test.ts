import { describe, expect, it, vi } from "vitest";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { basicTools } from "./shared";

describe("yamlXmlProtocol parseGeneratedText onError metadata", () => {
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
    expect(typeof metadata?.toolCallId).toBe("string");
    expect((metadata?.toolCallId as string).length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<get_weather>");
  });

  it("populates yaml-parse-error dropReason when the helper parser reports a YAML syntax error", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = "<get_weather>\n[invalid: yaml:\n</get_weather>";
    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { onError },
    });

    const helperError = onError.mock.calls.find(
      ([message]) => String(message) === "YAML parse error"
    );
    expect(helperError).toBeDefined();
    const metadata = helperError?.[1];
    expect(metadata).toMatchObject({
      dropReason: "yaml-parse-error",
    });
  });

  it("populates yaml-non-mapping dropReason when the YAML document is not a key-value mapping", () => {
    const onError = vi.fn();
    const protocol = yamlXmlProtocol();
    const text = "<get_weather>\njust a scalar string\n</get_weather>";
    protocol.parseGeneratedText({
      text,
      tools: basicTools,
      options: { onError },
    });

    const helperError = onError.mock.calls.find(
      ([message]) =>
        String(message) === "YAML content must be a key-value mapping"
    );
    expect(helperError).toBeDefined();
    const metadata = helperError?.[1];
    expect(metadata).toMatchObject({
      dropReason: "yaml-non-mapping",
    });
  });
});
