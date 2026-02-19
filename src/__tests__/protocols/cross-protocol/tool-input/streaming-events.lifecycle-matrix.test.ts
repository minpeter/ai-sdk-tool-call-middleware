import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { convertReadableStreamToArray } from "@ai-sdk/provider-utils/test";
import { describe, it } from "vitest";
import { dummyProtocol } from "../../../../core/protocols/dummy-protocol";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import {
  qwen3CoderProtocol,
  uiTarsXmlProtocol,
} from "../../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { toolInputStreamFixtures } from "../../../fixtures/tool-input-stream-fixtures";
import {
  pipeWithTransformer,
  stopFinishReason,
  zeroUsage,
} from "../../../test-helpers";

function createInterleavedStream(parts: LanguageModelV3StreamPart[]) {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.enqueue({
        type: "finish",
        finishReason: stopFinishReason,
        usage: zeroUsage,
      });
      controller.close();
    },
  });
}

function assertCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertCanonicalAiSdkEventOrder(parts: LanguageModelV3StreamPart[]) {
  const finishIndex = parts.findIndex((part) => part.type === "finish");
  assertCondition(finishIndex >= 0, "Missing finish event");
  assertCondition(
    finishIndex === parts.length - 1,
    "Finish event must be the final event"
  );

  const openTextSegments = new Map<string, number>();
  const openReasoningSegments = new Map<string, number>();
  const toolInputWindows = new Map<
    string,
    { startIndex: number; endIndex: number | null }
  >();

  parts.forEach((part, index) => {
    if (part.type === "text-start") {
      assertCondition(
        !openTextSegments.has(part.id),
        `Duplicate text-start for id '${part.id}'`
      );
      openTextSegments.set(part.id, index);
      return;
    }

    if (part.type === "text-delta") {
      assertCondition(
        openTextSegments.has(part.id),
        `text-delta without text-start for id '${part.id}'`
      );
      return;
    }

    if (part.type === "text-end") {
      const startIndex = openTextSegments.get(part.id);
      assertCondition(
        startIndex !== undefined,
        `text-end without text-start for id '${part.id}'`
      );
      assertCondition(
        (startIndex ?? index) < index,
        `text-end must occur after text-start for id '${part.id}'`
      );
      openTextSegments.delete(part.id);
      return;
    }

    if (part.type === "reasoning-start") {
      assertCondition(
        !openReasoningSegments.has(part.id),
        `Duplicate reasoning-start for id '${part.id}'`
      );
      openReasoningSegments.set(part.id, index);
      return;
    }

    if (part.type === "reasoning-delta") {
      assertCondition(
        openReasoningSegments.has(part.id),
        `reasoning-delta without reasoning-start for id '${part.id}'`
      );
      return;
    }

    if (part.type === "reasoning-end") {
      const startIndex = openReasoningSegments.get(part.id);
      assertCondition(
        startIndex !== undefined,
        `reasoning-end without reasoning-start for id '${part.id}'`
      );
      assertCondition(
        (startIndex ?? index) < index,
        `reasoning-end must occur after reasoning-start for id '${part.id}'`
      );
      openReasoningSegments.delete(part.id);
      return;
    }

    if (part.type === "tool-input-start") {
      assertCondition(
        !toolInputWindows.has(part.id),
        `Duplicate tool-input-start for id '${part.id}'`
      );
      toolInputWindows.set(part.id, { startIndex: index, endIndex: null });
      return;
    }

    if (part.type === "tool-input-delta") {
      const window = toolInputWindows.get(part.id);
      assertCondition(
        window !== undefined,
        `tool-input-delta without tool-input-start for id '${part.id}'`
      );
      assertCondition(
        (window?.startIndex ?? index) < index,
        `tool-input-delta must occur after tool-input-start for id '${part.id}'`
      );
      assertCondition(
        window?.endIndex == null,
        `tool-input-delta appears after tool-input-end for id '${part.id}'`
      );
      return;
    }

    if (part.type === "tool-input-end") {
      const window = toolInputWindows.get(part.id);
      assertCondition(
        window !== undefined,
        `tool-input-end without tool-input-start for id '${part.id}'`
      );
      assertCondition(
        (window?.startIndex ?? index) < index,
        `tool-input-end must occur after tool-input-start for id '${part.id}'`
      );
      assertCondition(
        window?.endIndex == null,
        `Duplicate tool-input-end for id '${part.id}'`
      );
      if (window) {
        window.endIndex = index;
      }
      return;
    }

    if (part.type === "tool-call") {
      const window = toolInputWindows.get(part.toolCallId);
      assertCondition(
        window !== undefined,
        `tool-call without tool-input-start for id '${part.toolCallId}'`
      );
      assertCondition(
        window?.endIndex != null,
        `tool-call before tool-input-end for id '${part.toolCallId}'`
      );
      assertCondition(
        (window?.endIndex ?? index) < index,
        `tool-call must occur after tool-input-end for id '${part.toolCallId}'`
      );
    }
  });

  assertCondition(
    openTextSegments.size === 0,
    `Unclosed text segments remain: ${openTextSegments.size}`
  );
  assertCondition(
    openReasoningSegments.size === 0,
    `Unclosed reasoning segments remain: ${openReasoningSegments.size}`
  );

  for (const window of toolInputWindows.values()) {
    assertCondition(
      window.endIndex != null,
      "Unclosed tool-input window found"
    );
  }
}

function assertHasEventTypes(
  parts: LanguageModelV3StreamPart[],
  requiredTypes: LanguageModelV3StreamPart["type"][]
) {
  const eventTypes = new Set(parts.map((part) => part.type));
  for (const eventType of requiredTypes) {
    assertCondition(
      eventTypes.has(eventType),
      `Missing event type '${eventType}'`
    );
  }
}

interface EventCheck {
  label: string;
  matches: (part: LanguageModelV3StreamPart) => boolean;
}

function assertEventSequence(
  parts: LanguageModelV3StreamPart[],
  checks: EventCheck[]
) {
  let prevIndex = -1;
  for (const check of checks) {
    const index = parts.findIndex(
      (part, candidateIndex) =>
        candidateIndex > prevIndex && check.matches(part)
    );
    assertCondition(index >= 0, `Missing expected event: ${check.label}`);
    prevIndex = index;
  }
}

function createOfficialPassthroughFixture(tag: string) {
  const reasoningId = `reasoning-${tag}`;
  const sourceUrlId = `source-url-${tag}`;
  const sourceDocumentId = `source-doc-${tag}`;
  const responseId = `response-${tag}`;
  const approvalId = `approval-${tag}`;
  const passthroughToolCallId = `passthrough-call-${tag}`;

  const parts: LanguageModelV3StreamPart[] = [
    {
      type: "stream-start",
      warnings: [],
    },
    {
      type: "reasoning-start",
      id: reasoningId,
    },
    {
      type: "reasoning-delta",
      id: reasoningId,
      delta: "thinking",
    },
    {
      type: "reasoning-end",
      id: reasoningId,
    },
    {
      type: "source",
      sourceType: "url",
      id: sourceUrlId,
      url: "https://example.com/rules",
      title: "Rules",
    },
    {
      type: "source",
      sourceType: "document",
      id: sourceDocumentId,
      mediaType: "application/pdf",
      title: "Spec",
      filename: "spec.pdf",
    },
    {
      type: "file",
      mediaType: "text/plain",
      data: "Y29tcGxpYW5jZQ==",
    },
    {
      type: "response-metadata",
      id: responseId,
      modelId: "compliance-model",
    },
    {
      type: "tool-approval-request",
      approvalId,
      toolCallId: passthroughToolCallId,
    },
    {
      type: "tool-input-start",
      id: passthroughToolCallId,
      toolName: "passthrough_marker",
    },
    {
      type: "tool-input-delta",
      id: passthroughToolCallId,
      delta: "{}",
    },
    {
      type: "tool-input-end",
      id: passthroughToolCallId,
    },
    {
      type: "tool-call",
      toolCallId: passthroughToolCallId,
      toolName: "passthrough_marker",
      input: "{}",
    },
    {
      type: "tool-result",
      toolCallId: passthroughToolCallId,
      toolName: "passthrough_marker",
      result: { ok: true },
    },
    {
      type: "raw",
      rawValue: { tag },
    },
    {
      type: "error",
      error: `error-${tag}`,
    },
  ];

  const checks: EventCheck[] = [
    {
      label: "stream-start",
      matches: (part) => part.type === "stream-start",
    },
    {
      label: "reasoning-start",
      matches: (part) =>
        part.type === "reasoning-start" && part.id === reasoningId,
    },
    {
      label: "reasoning-delta",
      matches: (part) =>
        part.type === "reasoning-delta" && part.id === reasoningId,
    },
    {
      label: "reasoning-end",
      matches: (part) =>
        part.type === "reasoning-end" && part.id === reasoningId,
    },
    {
      label: "source-url",
      matches: (part) =>
        part.type === "source" &&
        part.sourceType === "url" &&
        part.id === sourceUrlId,
    },
    {
      label: "source-document",
      matches: (part) =>
        part.type === "source" &&
        part.sourceType === "document" &&
        part.id === sourceDocumentId,
    },
    {
      label: "file",
      matches: (part) =>
        part.type === "file" && part.mediaType === "text/plain",
    },
    {
      label: "response-metadata",
      matches: (part) =>
        part.type === "response-metadata" && part.id === responseId,
    },
    {
      label: "tool-approval-request",
      matches: (part) =>
        part.type === "tool-approval-request" &&
        part.approvalId === approvalId &&
        part.toolCallId === passthroughToolCallId,
    },
    {
      label: "tool-input-start",
      matches: (part) =>
        part.type === "tool-input-start" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-input-delta",
      matches: (part) =>
        part.type === "tool-input-delta" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-input-end",
      matches: (part) =>
        part.type === "tool-input-end" && part.id === passthroughToolCallId,
    },
    {
      label: "tool-call",
      matches: (part) =>
        part.type === "tool-call" && part.toolCallId === passthroughToolCallId,
    },
    {
      label: "tool-result",
      matches: (part) =>
        part.type === "tool-result" &&
        part.toolCallId === passthroughToolCallId,
    },
    {
      label: "raw",
      matches: (part) => part.type === "raw",
    },
    {
      label: "error",
      matches: (part) => part.type === "error" && part.error === `error-${tag}`,
    },
  ];

  return { parts, checks };
}

const allOfficialEventTypes: LanguageModelV3StreamPart["type"][] = [
  "stream-start",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-approval-request",
  "tool-call",
  "tool-result",
  "source",
  "file",
  "response-metadata",
  "raw",
  "error",
  "finish",
];

describe("cross-protocol tool-input streaming events: lifecycle matrix", () => {
  const streamComplianceScenarios: Array<{
    name: string;
    tools: LanguageModelV3FunctionTool[];
    createProtocol: () => {
      createStreamParser: (options: {
        tools: LanguageModelV3FunctionTool[];
      }) => TransformStream<
        LanguageModelV3StreamPart,
        LanguageModelV3StreamPart
      >;
    };
    openChunk: string;
    closeChunk: string;
  }> = [
    {
      name: "hermes-json",
      tools: toolInputStreamFixtures.json.tools,
      createProtocol: () => hermesProtocol(),
      openChunk: 'Before <tool_call>{"name":"get_weather","arguments":',
      closeChunk: '{"location":"Seoul","unit":"celsius"}</tool_call> After',
    },
    {
      name: "morph-xml",
      tools: toolInputStreamFixtures.xml.tools,
      createProtocol: () => morphXmlProtocol(),
      openChunk: "Before <get_weather>\n<location>",
      closeChunk:
        "Seoul</location>\n<unit>celsius</unit>\n</get_weather> After",
    },
    {
      name: "yaml-xml",
      tools: toolInputStreamFixtures.yaml.tools,
      createProtocol: () => yamlXmlProtocol(),
      openChunk: "Before <get_weather>\nlocation: ",
      closeChunk: "Seoul\nunit: celsius\n</get_weather> After",
    },
    {
      name: "qwen3coder",
      tools: toolInputStreamFixtures.json.tools,
      createProtocol: () => qwen3CoderProtocol(),
      openChunk: "Before <tool_call><function=get_weather><parameter=location>",
      closeChunk:
        "Seoul</parameter><parameter=unit>celsius</parameter></function></tool_call> After",
    },
    {
      name: "ui-tars-xml",
      tools: toolInputStreamFixtures.json.tools,
      createProtocol: () => uiTarsXmlProtocol(),
      openChunk: "Before <tool_call><function=get_weather><parameter=location>",
      closeChunk:
        "Seoul</parameter><parameter=unit>celsius</parameter></function></tool_call> After",
    },
    {
      name: "dummy-passthrough",
      tools: [],
      createProtocol: () => dummyProtocol(),
      openChunk: "(open-chunk)",
      closeChunk: "(close-chunk)",
    },
  ];

  for (const scenario of streamComplianceScenarios) {
    it(`${scenario.name} preserves official AI SDK event lifecycles across all stream-part types`, async () => {
      const { parts: passthroughParts, checks } =
        createOfficialPassthroughFixture(scenario.name);
      const protocol = scenario.createProtocol();
      const transformer = protocol.createStreamParser({
        tools: scenario.tools,
      });

      const out = await convertReadableStreamToArray(
        pipeWithTransformer(
          createInterleavedStream([
            {
              type: "text-delta",
              id: `seed-open-${scenario.name}`,
              delta: scenario.openChunk,
            },
            ...passthroughParts,
            {
              type: "text-delta",
              id: `seed-close-${scenario.name}`,
              delta: scenario.closeChunk,
            },
          ]),
          transformer
        )
      );

      assertCanonicalAiSdkEventOrder(out);
      assertEventSequence(out, checks);
      assertHasEventTypes(out, allOfficialEventTypes);
    });
  }
});
