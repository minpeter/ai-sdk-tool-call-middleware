import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
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
  allOfficialEventTypes,
  assertCanonicalAiSdkEventOrder,
  assertEventSequence,
  assertHasEventTypes,
  createInterleavedStream,
  createOfficialPassthroughFixture,
  runProtocolStreamParser,
} from "./streaming-events.shared";

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
      closeChunk: '{"location":"Seoul","unit":"celsius"}}</tool_call> After',
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
      const out = await runProtocolStreamParser({
        protocol,
        tools: scenario.tools,
        stream: createInterleavedStream([
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
      });

      assertCanonicalAiSdkEventOrder(out);
      assertEventSequence(out, checks);
      assertHasEventTypes(out, allOfficialEventTypes);
    });
  }
});
