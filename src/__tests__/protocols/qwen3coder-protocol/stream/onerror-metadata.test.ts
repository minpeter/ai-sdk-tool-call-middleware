import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import {
  collectTextDeltas,
  runProtocolTextStream,
  selectToolCalls,
} from "../../shared/duplicate-harness";

type OnError = NonNullable<ParserOptions["onError"]>;

const bookFlightTool = {
  type: "function",
  name: "book_flight",
  inputSchema: {
    type: "object",
    properties: { cabin: { type: "string" } },
  },
} satisfies LanguageModelV4FunctionTool;

function runErrorStream(
  delta: string,
  tools: LanguageModelV4FunctionTool[],
  parserOptions: ParserOptions
): Promise<LanguageModelV4StreamPart[]> {
  return runProtocolTextStream({
    chunks: [delta],
    id: "1",
    protocol: qwen3CoderProtocol(),
    tools,
    parserOptions,
  });
}

interface SensitiveStreamScenario {
  readonly expectedInput: string;
  readonly expectedText: string;
  readonly forbiddenMetadata: readonly string[];
  readonly name: string;
  readonly text: string;
}

function sensitiveStreamScenarios(): SensitiveStreamScenario[] {
  const scenarios: SensitiveStreamScenario[] = [];
  for (const parameterName of ["__proto__", "constructor", "prototype"]) {
    scenarios.push(
      {
        name: `drops wrapperless partial prototype-sensitive arg trailing text for ${parameterName}`,
        text: `<function=book_flight><parameter=${parameterName}`,
        expectedInput: "{}",
        expectedText: "",
        forbiddenMetadata: [parameterName, "<parameter="],
      },
      {
        name: `drops standalone prototype-sensitive parameter trailing text after wrapperless call for ${parameterName}`,
        text:
          "<function=book_flight><parameter=cabin>economy</parameter></function>" +
          `<parameter=${parameterName}>{"polluted":true}</parameter>`,
        expectedInput: '{"cabin":"economy"}',
        expectedText: "",
        forbiddenMetadata: [parameterName, "<parameter="],
      },
      {
        name: `preserves safe text after dropped standalone prototype-sensitive parameter trailing text for ${parameterName}`,
        text:
          "<function=book_flight><parameter=cabin>economy</parameter></function>" +
          `<parameter=${parameterName}>{"polluted":true}</parameter> after`,
        expectedInput: '{"cabin":"economy"}',
        expectedText: " after",
        forbiddenMetadata: [parameterName, "<parameter="],
      }
    );
  }
  scenarios.push(
    {
      name: "preserves safe text after dropped entity-encoded standalone prototype-sensitive parameter trailing text",
      text:
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
        '<parameter name="&#99;onstructor">{"polluted":true}</parameter> after',
      expectedInput: '{"cabin":"economy"}',
      expectedText: " after",
      forbiddenMetadata: ["polluted", "&#99;onstructor"],
    },
    {
      name: "preserves safe text after dropped unquoted-name standalone prototype-sensitive parameter trailing text",
      text:
        "<function=book_flight><parameter=cabin>economy</parameter></function>" +
        '<parameter name=constructor>{"polluted":true}</parameter> after',
      expectedInput: '{"cabin":"economy"}',
      expectedText: " after",
      forbiddenMetadata: ["polluted", "name=constructor"],
    }
  );
  return scenarios;
}

describe("qwen3CoderProtocol streaming onError metadata", () => {
  it("populates unresolved-tool-name dropReason with toolCallId when streaming tool name cannot be resolved", async () => {
    const onError = vi.fn<OnError>();
    await runErrorStream(
      "<tool_call><function><parameter=x>1</parameter></function></tool_call>",
      [],
      { onError }
    );
    const resolveFail = onError.mock.calls.find(([message]) =>
      String(message).includes(
        "Could not resolve Qwen3CoderToolParser tool name"
      )
    );
    expect(resolveFail).toBeDefined();
    const metadata = resolveFail?.[1];
    expect(metadata).toMatchObject({ dropReason: "unresolved-tool-name" });
    const toolCallId = metadata?.toolCallId;
    expect(typeof toolCallId).toBe("string");
    if (typeof toolCallId !== "string") {
      throw new TypeError("Expected non-empty metadata tool-call ID");
    }
    expect(toolCallId.length).toBeGreaterThan(0);
  });

  it("redacts prototype-sensitive streaming stringify errors in metadata", async () => {
    const onError = vi.fn<OnError>();
    await runErrorStream(
      '<tool_call><function=book_flight><parameter=constructor>{"polluted":true}</parameter></function></tool_call>',
      [bookFlightTool],
      { emitRawToolCallTextOnError: true, onError }
    );
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[1]?.error).toBe(
      "[redacted sensitive tool call]"
    );
  });

  for (const scenario of sensitiveStreamScenarios()) {
    it(scenario.name, async () => {
      const { expectedInput, expectedText, forbiddenMetadata, text } = scenario;
      const onError = vi.fn<OnError>();
      const out = await runErrorStream(text, [bookFlightTool], {
        emitRawToolCallTextOnError: true,
        onError,
      });
      expect(selectToolCalls(out)[0]).toMatchObject({
        type: "tool-call",
        toolName: "book_flight",
        input: expectedInput,
      });
      expect(collectTextDeltas(out)).toBe(expectedText);
      expect(onError).toHaveBeenCalled();
      const metadataText = JSON.stringify(onError.mock.calls);
      expect(metadataText).toContain("[redacted sensitive tool call]");
      for (const forbidden of forbiddenMetadata) {
        expect(metadataText).not.toContain(forbidden);
      }
    });
  }

  it("preserves ordinary prose that mentions constructor as a label", async () => {
    const onError = vi.fn<OnError>();
    const out = await runErrorStream("constructor: ordinary prose", [], {
      emitRawToolCallTextOnError: true,
      onError,
    });
    expect(collectTextDeltas(out)).toBe("constructor: ordinary prose");
    expect(onError).not.toHaveBeenCalled();
  });
});
