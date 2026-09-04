import { describe, expect, it, vi } from "vitest";
import type {
  ParserOptions,
  ProtocolMetadata,
} from "../../../../core/protocols/protocol-interface";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
} from "../../shared/duplicate-harness";
import { basicTools } from "../parse-generated-text/shared";

type OnError = NonNullable<ParserOptions["onError"]>;

interface FailureObservation {
  readonly metadataText: string;
  readonly onError: ReturnType<typeof vi.fn<OnError>>;
  readonly parts: Awaited<ReturnType<typeof runProtocolTextStream>>;
}

const prototypeSensitiveKeys = [
  "__proto__",
  "constructor",
  "prototype",
] as const;

async function observeFailure(
  text: string,
  emitRawToolCallTextOnError = false
): Promise<FailureObservation> {
  const onError = vi.fn<OnError>();
  const parts = await runProtocolTextStream({
    protocol: yamlXmlProtocol(),
    tools: basicTools,
    id: "1",
    chunks: [text],
    parserOptions: { emitRawToolCallTextOnError, onError },
  });
  return { onError, parts, metadataText: JSON.stringify(onError.mock.calls) };
}

function expectSingleRedactedFailure(
  observation: FailureObservation,
  forbidden: readonly string[]
): void {
  expect(collectTextDeltas(observation.parts)).toBe("");
  expect(observation.onError).toHaveBeenCalledTimes(1);
  expect(observation.metadataText).toContain("[redacted sensitive tool call]");
  for (const value of forbidden) {
    expect(observation.metadataText).not.toContain(value);
  }
}

describe("yamlXmlProtocol streaming onError metadata", () => {
  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when streaming YAML body parse fails", async () => {
    const { onError } = await observeFailure(
      "<get_weather>\n[invalid: yaml:\n</get_weather>"
    );
    const parseFail = onError.mock.calls.find(([message]) =>
      message.includes("Could not parse streaming YAML tool call")
    );
    expect(parseFail).toBeDefined();
    const metadata = parseFail?.[1];
    expect(metadata).toMatchObject({
      toolName: "get_weather",
      dropReason: "malformed-tool-call-body",
    });
    const toolCallId = metadata?.toolCallId;
    expect(toolCallId).toSatisfy((value) => typeof value === "string");
    if (typeof toolCallId !== "string") {
      throw new TypeError("Expected YAML error metadata tool-call ID");
    }
    expect(toolCallId.length).toBeGreaterThan(0);
    expect(metadata?.toolCall).toContain("<get_weather>");
  });

  it.each(prototypeSensitiveKeys)(
    "redacts malformed XML-wrapped YAML keys for %s",
    async (key) => {
      const observation = await observeFailure(
        `<get_weather>${key}: [</get_weather>`,
        true
      );
      expectSingleRedactedFailure(observation, [key, "<get_weather>"]);
    }
  );

  const stringifyCases = [
    {
      name: "redacts prototype-sensitive streaming stringify errors in metadata",
      text: "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n</get_weather>",
    },
    {
      name: "redacts prototype-sensitive streaming finish stringify errors in metadata",
      text: "<get_weather>\nlocation: Seoul\nconstructor:\n  polluted: true\n",
    },
  ] as const;

  for (const testCase of stringifyCases) {
    it(testCase.name, async () => {
      const { onError, parts } = await observeFailure(testCase.text, true);
      expect(onError).toHaveBeenCalledTimes(1);
      const metadata: ProtocolMetadata | undefined = onError.mock.calls[0]?.[1];
      expect(metadata?.error).toBe("[redacted sensitive tool call]");
      expect(
        parts.filter((part) => part.type === "tool-input-end")
      ).toHaveLength(1);
      expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    });
  }
});
