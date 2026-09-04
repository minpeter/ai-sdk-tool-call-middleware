import type { JSONSchema7 } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import {
  parseToolCallObject,
  requireToolCall,
  runProtocolTextStream,
  selectToolCalls,
  selectToolInputTimeline,
} from "../../shared/duplicate-harness";

const slowKey = `${"a".repeat(24)}!`;

const patternRepairCases = [
  {
    name: "fails closed for unsafe patternProperties without leaking tool-input events",
    pattern: "^(a+)+$",
    patternSchema: { type: "string" },
    additionalProperties: false,
    argumentKey: slowKey,
    expected: "reject",
  },
  {
    name: "drops unsafe false patternProperties when unknown keys are allowed",
    pattern: "^(a+)+$",
    patternSchema: false,
    additionalProperties: true,
    argumentKey: slowKey,
    expected: { content: "ok" },
  },
  {
    name: "drops unsafe false patternProperties with character classes",
    pattern: "^(a|[0-9])+$",
    patternSchema: false,
    additionalProperties: true,
    argumentKey: "123",
    expected: { content: "ok" },
  },
  {
    name: "drops unsafe false patternProperties with escaped literals",
    pattern: "^(\\x61+)+$",
    patternSchema: false,
    additionalProperties: true,
    argumentKey: "aaaa",
    expected: { content: "ok" },
  },
  {
    name: "drops unsafe false patternProperties with unknown matchers",
    pattern: "^([^\\n]+)+$",
    patternSchema: false,
    additionalProperties: true,
    argumentKey: "secret",
    expected: { content: "ok" },
  },
  {
    name: "preserves safe additional keys when an unsafe false pattern contains character classes",
    pattern: "^(a|[0-9])+$",
    patternSchema: false,
    additionalProperties: true,
    argumentKey: "note",
    argumentValue: "safe",
    expected: { content: "ok", note: "safe" },
  },
] as const satisfies readonly {
  readonly additionalProperties: boolean;
  readonly argumentKey: string;
  readonly argumentValue?: string;
  readonly expected: "reject" | object;
  readonly name: string;
  readonly pattern: string;
  readonly patternSchema: JSONSchema7 | false;
}[];

describe("json-repair.test split 5", () => {
  for (const testCase of patternRepairCases) {
    it(testCase.name, async () => {
      const onError = vi.fn();
      const argumentValue =
        "argumentValue" in testCase ? testCase.argumentValue : "blocked";
      const inputSchema: JSONSchema7 = {
        type: "object",
        properties: { content: { type: "string" } },
        patternProperties: {
          [testCase.pattern]: testCase.patternSchema,
        },
        additionalProperties: testCase.additionalProperties,
      };
      const output = await runProtocolTextStream({
        chunks: [
          `<tool_call>${JSON.stringify({
            name: "write",
            arguments: {
              content: "ok",
              [testCase.argumentKey]: argumentValue,
            },
          })}</tool_call>`,
        ],
        id: "1",
        protocol: hermesProtocol(),
        tools: [{ type: "function", name: "write", inputSchema }],
        parserOptions: { onError },
      });

      if (testCase.expected === "reject") {
        expect(selectToolCalls(output)).toEqual([]);
        expect(selectToolInputTimeline(output)).toEqual({
          starts: [],
          deltas: [],
          ends: [],
        });
        expect(onError).toHaveBeenCalled();
        return;
      }

      expect(parseToolCallObject(requireToolCall(output))).toEqual(
        testCase.expected
      );
      if (testCase.name !== patternRepairCases.at(-1)?.name) {
        const events = selectToolInputTimeline(output);
        expect(events.starts.length).toBeGreaterThan(0);
        expect(events.deltas.length).toBeGreaterThan(0);
        expect(events.ends.length).toBeGreaterThan(0);
      }
      expect(onError).not.toHaveBeenCalled();
    });
  }
});
