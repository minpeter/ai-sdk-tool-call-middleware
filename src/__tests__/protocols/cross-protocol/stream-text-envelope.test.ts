import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../core/protocols/yaml-xml-protocol";
import { stopFinishReason, zeroUsage } from "../../test-helpers";
import {
  collectTextDeltas,
  observeLifecycle,
} from "../shared/duplicate-harness";

// Providers emit text-start/text-delta/text-end envelopes. The protocol
// parsers re-segment text under their own synthetic ids, so the original
// envelopes must be consumed rather than passed through (which would produce
// an empty duplicate text block with a dangling id).

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

const protocols = [
  { name: "hermes", protocol: hermesProtocol() },
  { name: "morph-xml", protocol: morphXmlProtocol() },
  { name: "qwen3coder", protocol: qwen3CoderProtocol() },
  { name: "yaml-xml", protocol: yamlXmlProtocol() },
];

function envelopeParts(text: string): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [
    { type: "text-start", id: "orig-1" },
  ];
  for (const delta of text.match(/[\s\S]{1,5}/g) ?? []) {
    parts.push({ type: "text-delta", id: "orig-1", delta });
  }
  parts.push(
    { type: "text-end", id: "orig-1" },
    {
      type: "finish",
      finishReason: stopFinishReason,
      usage: zeroUsage,
    }
  );
  return parts;
}

describe("cross-protocol: provider text envelopes are re-segmented, not duplicated", () => {
  for (const { name, protocol } of protocols) {
    it(`${name}: plain text keeps a single balanced synthetic text block`, async () => {
      const { parts: out } = await observeLifecycle({
        parts: envelopeParts("hello world, no tools needed."),
        protocol,
        tools,
      });

      const starts = out.filter((part) => part.type === "text-start");
      const ends = out.filter((part) => part.type === "text-end");

      // The original envelope must not leak through with its provider id.
      for (const part of [...starts, ...ends]) {
        expect(part.id).not.toBe("orig-1");
      }
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);

      const text = collectTextDeltas(out);
      expect(text).toBe("hello world, no tools needed.");
    });
  }
});
