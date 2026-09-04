import { describe, expect, it, vi } from "vitest";
import type {
  ParserOptions,
  ProtocolMetadataValue,
} from "../../../../core/protocols/protocol-interface";
import { basicTools, collectGeneratedText, parseYamlGenerated } from "./shared";

type OnError = NonNullable<ParserOptions["onError"]>;

function expectNonEmptyString(value: ProtocolMetadataValue): void {
  expect(typeof value).toBe("string");
  if (typeof value !== "string") {
    throw new TypeError("Expected non-empty metadata string");
  }
  expect(value.length).toBeGreaterThan(0);
}

const malformedCases = [
  {
    name: "attaches yaml-parse-error cause to the uniform malformed-tool-call-body onError metadata when YAML syntax fails",
    text: "<get_weather>\n[invalid: yaml:\n</get_weather>",
    cause: "yaml-parse-error",
  },
  {
    name: "attaches yaml-non-mapping cause to the uniform malformed-tool-call-body onError metadata when the YAML document is not a mapping",
    text: "<get_weather>\njust a scalar string\n</get_weather>",
    cause: "yaml-non-mapping",
  },
];

function parseWithError(text: string, onError: OnError) {
  return parseYamlGenerated(text, basicTools, { onError });
}

describe("yamlXmlProtocol parseGeneratedText onError metadata", () => {
  const prototypeSensitiveKeys: readonly string[] = [
    "__proto__",
    "constructor",
    "prototype",
  ];

  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when YAML body parse fails", () => {
    const onError = vi.fn<OnError>();
    parseWithError("<get_weather>\n[invalid: yaml:\n</get_weather>", onError);

    const parseFail = onError.mock.calls.find(([message]) =>
      String(message).includes("Could not parse YAML tool call")
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "malformed-tool-call-body",
    });
    expectNonEmptyString(metadata?.toolCallId);
    expect(metadata?.toolCall).toContain("<get_weather>");
  });

  for (const testCase of malformedCases) {
    it(testCase.name, () => {
      const onError = vi.fn<OnError>();
      parseWithError(testCase.text, onError);

      expect(onError).toHaveBeenCalledTimes(1);
      const [message, metadata] = onError.mock.calls[0];
      expect(String(message)).toBe("Could not parse YAML tool call");
      expect(metadata).toMatchObject({
        toolName: "get_weather",
        dropReason: "malformed-tool-call-body",
      });
      expect(metadata?.cause).toMatchObject({ kind: testCase.cause });
      expectNonEmptyString(metadata?.toolCallId);
    });
  }

  it.each(prototypeSensitiveKeys)(
    "redacts malformed XML-wrapped YAML keys for %s",
    (key) => {
      const onError = vi.fn<OnError>();
      const out = parseYamlGenerated(
        `<get_weather>${key}: [</get_weather>`,
        basicTools,
        { emitRawToolCallTextOnError: true, onError }
      );

      expect(collectGeneratedText(out)).toBe("");
      expect(onError).toHaveBeenCalledTimes(1);
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      expect(metadataText).not.toContain(key);
      expect(metadataText).not.toContain("<get_weather>");
    }
  );

  it("redacts prototype-sensitive stringify errors in metadata", () => {
    const onError = vi.fn<OnError>();
    parseYamlGenerated(
      "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
      basicTools,
      { emitRawToolCallTextOnError: true, onError }
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]?.error).toBe(
      "[redacted sensitive tool call]"
    );
  });
});
