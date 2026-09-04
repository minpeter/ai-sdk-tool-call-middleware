import { describe, expect, it } from "vitest";
import type { ProtocolMetadataJsonObject } from "../../../../core/protocols/protocol-interface";
import { qwen3CoderProtocol } from "../../../../core/protocols/qwen3coder-protocol";
import { emptyFunctionTools } from "../../../fixtures/function-tools";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

interface MetadataScenario {
  readonly expectedToolName?: string;
  readonly name: string;
  readonly text: string;
}

const scenarios: readonly MetadataScenario[] = [
  {
    name: "populates toolCallId and malformed-tool-call-body dropReason when a wrapped <tool_call> segment fails to parse",
    text: "before <tool_call><function><parameter=x>1</parameter></function></tool_call> after",
  },
  {
    name: "salvages toolName from markup when the whole segment fails to parse but a recognizable call tag is present",
    text: "<tool_call><function=alpha></function><function garbage nothing></function></tool_call>",
    expectedToolName: "alpha",
  },
];

describe("qwen3CoderProtocol parseGeneratedText onError metadata", () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const failures: ProtocolMetadataJsonObject[] = [];
      runGeneratedJsonRepair({
        protocol: qwen3CoderProtocol(),
        text: scenario.text,
        tools: emptyFunctionTools,
        parserOptions: {
          onError(message, details) {
            if (
              message.includes(
                "Could not process Qwen3CoderToolParser XML tool call"
              ) &&
              details
            ) {
              failures.push(details);
            }
          },
        },
      });
      const [metadata] = failures;
      expect(metadata).toBeDefined();
      expect(metadata?.dropReason).toBe("malformed-tool-call-body");
      if (scenario.expectedToolName) {
        expect(metadata?.toolName).toBe(scenario.expectedToolName);
      }
      const toolCallId = metadata?.toolCallId;
      expect(typeof toolCallId).toBe("string");
      if (typeof toolCallId === "string") {
        expect(toolCallId.length).toBeGreaterThan(0);
      }
      if (!scenario.expectedToolName) {
        expect(metadata?.toolCall).toContain("<tool_call>");
      }
    });
  }
});
