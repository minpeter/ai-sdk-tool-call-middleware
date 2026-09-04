import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { ProtocolMetadata } from "../../../../core/protocols/protocol-interface";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

interface ErrorRecord {
  readonly message: string;
  readonly metadata?: ProtocolMetadata;
}

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "write_file",
    description: "",
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

async function observeFailure(
  chunks: readonly string[],
  emitRawToolCallTextOnError = false
) {
  const errors: ErrorRecord[] = [];
  const out = await runProtocolTextStream({
    protocol: morphXmlProtocol(),
    tools,
    id: "1",
    chunks,
    parserOptions: {
      emitRawToolCallTextOnError,
      onError(message, metadata) {
        errors.push({ message, metadata });
      },
    },
  });
  return {
    errors,
    out,
    joinedText: collectTextDeltas(out),
    joinedToolInput: selectToolInputTimeline(out)
      .deltas.map((part) => part.delta)
      .join(""),
    metadataText: JSON.stringify(errors),
  };
}

function expectNoSensitiveOutput(
  observation: Awaited<ReturnType<typeof observeFailure>>,
  sentinels: readonly string[]
): void {
  expect(selectToolCalls(observation.out)).toHaveLength(0);
  expect(observation.joinedText).toBe("");
  for (const sentinel of sentinels) {
    expect(observation.joinedToolInput).not.toContain(sentinel);
    expect(observation.metadataText).not.toContain(sentinel);
  }
  expect(observation.metadataText).toContain("[redacted sensitive tool call]");
}

describe("morphXmlProtocol streaming onError metadata", () => {
  it("populates toolName, toolCallId, and malformed-tool-call-body dropReason when streaming XML body parse fails", async () => {
    const observation = await observeFailure([
      "<write_file><file_path>a</file_path><file_path>b</file_path></write_file>",
    ]);
    const parseFail = observation.errors.find(({ message }) =>
      message.includes("Could not process streaming XML tool call")
    );
    expect(parseFail).toBeDefined();
    expect(parseFail?.metadata).toMatchObject({
      toolName: "write_file",
      dropReason: "malformed-tool-call-body",
    });
    const toolCallId = parseFail?.metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    if (typeof toolCallId !== "string") {
      throw new TypeError("Expected error metadata toolCallId");
    }
    expect(toolCallId.length).toBeGreaterThan(0);
    expect(parseFail?.metadata?.toolCall).toContain("<write_file>");
    expect(parseFail?.metadata?.toolCall).toContain("</write_file>");
  });

  it("drops XML-wrapped YAML-like sensitive fallback without leaking raw text", async () => {
    const pathSentinel = "sentinel-path-secret";
    const contentSentinel = "sentinel-content-secret";
    const observation = await observeFailure(
      [
        `<write_file><file_path>${pathSentinel}</file_path>`,
        `<file_path>b</file_path><contents>constructor: true\n"secret": ${contentSentinel}</contents></write_file>`,
      ],
      true
    );
    expectNoSensitiveOutput(observation, [pathSentinel, contentSentinel]);
  });

  it("does not leak open string progress before a later prototype-sensitive failure", async () => {
    const sentinel = "first-chunk-scalar-secret";
    const observation = await observeFailure(
      [
        `<write_file><contents>${sentinel}`,
        "</contents><file_path>a</file_path><file_path>b</file_path><constructor><polluted>true</polluted></constructor></write_file>",
      ],
      true
    );
    expectNoSensitiveOutput(observation, [sentinel]);
  });
});
