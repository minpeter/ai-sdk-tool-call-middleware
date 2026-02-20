import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../../../core/protocols/hermes-protocol";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import type { TCMProtocol } from "../../../../core/protocols/protocol-interface";
import {
  qwen3CoderProtocol,
  uiTarsXmlProtocol,
} from "../../../../core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { runProtocolTextDeltaStream } from "./streaming-events.shared";

type DeltaJoinExpectation = "equal" | "diverges";

function assertIncludesAll(
  value: string,
  needles: string[],
  label: string
): void {
  for (const needle of needles) {
    if (!value.includes(needle)) {
      throw new Error(`${label}: missing '${needle}' in '${value}'`);
    }
  }
}

function assertExcludesAll(
  value: string,
  needles: string[],
  label: string
): void {
  for (const needle of needles) {
    if (value.includes(needle)) {
      throw new Error(`${label}: unexpected '${needle}' in '${value}'`);
    }
  }
}

describe("cross-protocol tool-input streaming events: literal angle-bracket arg values", () => {
  const literalValue = "<Ctrl+C>ahi, my name is pi<Esc><Enter>";

  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "send_keys",
      description: "Send terminal key sequence",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
    },
  ];

  function toCharacterChunks(text: string): string[] {
    return text.split("");
  }

  function assertLiteralAngleValue(value: string): void {
    assertIncludesAll(value, ["<Ctrl+C>", "<Esc>", "<Enter>"], "literal value");
    assertExcludesAll(value, ["&lt;", "&gt;", "&amp;"], "literal value");
  }

  const scenarios: Array<{
    name: string;
    protocol: TCMProtocol;
    variants: Array<{
      variantName: string;
      rawModelOutput: string;
      deltaJoinExpectation: DeltaJoinExpectation;
    }>;
  }> = [
    {
      name: "hermes",
      protocol: hermesProtocol(),
      variants: [
        {
          variantName: "escaped-sequence input",
          rawModelOutput:
            '<tool_call>{"name":"send_keys","arguments":{"value":"\\u003cCtrl+C\\u003eahi, my name is pi\\u003cEsc\\u003e\\u003cEnter\\u003e"}}</tool_call>',
          deltaJoinExpectation: "equal",
        },
        {
          variantName: "raw-angle input",
          rawModelOutput:
            '<tool_call>{"name":"send_keys","arguments":{"value":"<Ctrl+C>ahi, my name is pi<Esc><Enter>"}}</tool_call>',
          deltaJoinExpectation: "equal",
        },
      ],
    },
    {
      name: "morph-xml",
      protocol: morphXmlProtocol(),
      variants: [
        {
          variantName: "entity-escaped input",
          rawModelOutput:
            "<send_keys><value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</value></send_keys>",
          deltaJoinExpectation: "diverges",
        },
        {
          variantName: "raw-angle input",
          rawModelOutput:
            "<send_keys><value><Ctrl+C>ahi, my name is pi<Esc><Enter></value></send_keys>",
          deltaJoinExpectation: "equal",
        },
      ],
    },
    {
      name: "yaml-xml",
      protocol: yamlXmlProtocol(),
      variants: [
        {
          variantName: "escaped-sequence input",
          rawModelOutput:
            '<send_keys>\nvalue: "\\u003cCtrl+C\\u003eahi, my name is pi\\u003cEsc\\u003e\\u003cEnter\\u003e"\n</send_keys>',
          deltaJoinExpectation: "equal",
        },
        {
          variantName: "raw-angle input",
          rawModelOutput:
            "<send_keys>\nvalue: '<Ctrl+C>ahi, my name is pi<Esc><Enter>'\n</send_keys>",
          deltaJoinExpectation: "equal",
        },
      ],
    },
    {
      name: "qwen3coder",
      protocol: qwen3CoderProtocol(),
      variants: [
        {
          variantName: "entity-escaped input",
          rawModelOutput:
            "<tool_call><function=send_keys><parameter=value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</parameter></function></tool_call>",
          deltaJoinExpectation: "diverges",
        },
        {
          variantName: "raw-angle input",
          rawModelOutput:
            "<tool_call><function=send_keys><parameter=value><Ctrl+C>ahi, my name is pi<Esc><Enter></parameter></function></tool_call>",
          deltaJoinExpectation: "diverges",
        },
      ],
    },
    {
      name: "ui-tars-xml-alias-coverage",
      protocol: uiTarsXmlProtocol(),
      variants: [
        {
          variantName: "entity-escaped input",
          rawModelOutput:
            "<tool_call><function=send_keys><parameter=value>&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;</parameter></function></tool_call>",
          deltaJoinExpectation: "diverges",
        },
        {
          variantName: "raw-angle input",
          rawModelOutput:
            "<tool_call><function=send_keys><parameter=value><Ctrl+C>ahi, my name is pi<Esc><Enter></parameter></function></tool_call>",
          deltaJoinExpectation: "diverges",
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    for (const variant of scenario.variants) {
      it(`${scenario.name} ${variant.variantName} parseGeneratedText keeps literal '<' and '>'`, () => {
        const parsed = scenario.protocol.parseGeneratedText({
          text: variant.rawModelOutput,
          tools,
        });

        const toolCall = parsed.find(
          (
            part
          ): part is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
            part.type === "tool-call" && part.toolName === "send_keys"
        );

        expect(toolCall).toBeTruthy();
        if (!toolCall) {
          throw new Error("Expected parsed send_keys tool-call");
        }

        const input = JSON.parse(toolCall.input) as { value: string };
        expect(input).toEqual({ value: literalValue });
        assertLiteralAngleValue(input.value);
      });

      it(`${scenario.name} ${variant.variantName} stream parser keeps literal '<' and '>'`, async () => {
        const out = await runProtocolTextDeltaStream({
          protocol: scenario.protocol,
          tools,
          chunks: toCharacterChunks(variant.rawModelOutput),
        });

        const toolCall = out.find(
          (
            part
          ): part is Extract<
            LanguageModelV3StreamPart,
            { type: "tool-call" }
          > => part.type === "tool-call" && part.toolName === "send_keys"
        );

        expect(toolCall).toBeTruthy();
        if (!toolCall) {
          throw new Error("Expected streamed send_keys tool-call");
        }

        const input = JSON.parse(toolCall.input) as { value: string };
        expect(input).toEqual({ value: literalValue });
        assertLiteralAngleValue(input.value);

        const deltas = out.filter(
          (
            part
          ): part is Extract<
            LanguageModelV3StreamPart,
            { type: "tool-input-delta" }
          > =>
            part.type === "tool-input-delta" && part.id === toolCall.toolCallId
        );

        expect(deltas.length).toBeGreaterThan(0);

        const joined = deltas.map((part) => part.delta).join("");
        if (variant.deltaJoinExpectation === "equal") {
          expect(joined).toBe(toolCall.input);
          const deltaInput = JSON.parse(joined) as { value: string };
          expect(deltaInput).toEqual({ value: literalValue });
          assertLiteralAngleValue(deltaInput.value);
          return;
        }

        expect(joined).not.toBe(toolCall.input);
        expect(joined.startsWith('{"value":"')).toBe(true);
      });
    }
  }
});

describe("cross-protocol tool-input streaming events: double-escaped entity literals", () => {
  const entityLiteralValue =
    "&lt;Ctrl+C&gt;ahi, my name is pi&lt;Esc&gt;&lt;Enter&gt;";

  const tools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "send_keys",
      description: "Send terminal key sequence",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
    },
  ];

  function toCharacterChunks(text: string): string[] {
    return text.split("");
  }

  function assertEntityLiteralValue(value: string): void {
    assertIncludesAll(
      value,
      ["&lt;Ctrl+C&gt;", "&lt;Esc&gt;", "&lt;Enter&gt;"],
      "entity-literal value"
    );
    assertExcludesAll(
      value,
      ["<Ctrl+C>", "<Esc>", "<Enter>", "&amp;"],
      "entity-literal value"
    );
  }

  const scenarios: Array<{
    name: string;
    protocol: TCMProtocol;
    rawModelOutput: string;
    deltaJoinExpectation: DeltaJoinExpectation;
  }> = [
    {
      name: "morph-xml",
      protocol: morphXmlProtocol(),
      rawModelOutput:
        "<send_keys><value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</value></send_keys>",
      deltaJoinExpectation: "diverges",
    },
    {
      name: "qwen3coder",
      protocol: qwen3CoderProtocol(),
      rawModelOutput:
        "<tool_call><function=send_keys><parameter=value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</parameter></function></tool_call>",
      deltaJoinExpectation: "diverges",
    },
    {
      name: "ui-tars-xml-alias-coverage",
      protocol: uiTarsXmlProtocol(),
      rawModelOutput:
        "<tool_call><function=send_keys><parameter=value>&amp;lt;Ctrl+C&amp;gt;ahi, my name is pi&amp;lt;Esc&amp;gt;&amp;lt;Enter&amp;gt;</parameter></function></tool_call>",
      deltaJoinExpectation: "diverges",
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name} parseGeneratedText turns '&amp;lt;' into literal '&lt;' text`, () => {
      const parsed = scenario.protocol.parseGeneratedText({
        text: scenario.rawModelOutput,
        tools,
      });

      const toolCall = parsed.find(
        (
          part
        ): part is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
          part.type === "tool-call" && part.toolName === "send_keys"
      );

      expect(toolCall).toBeTruthy();
      if (!toolCall) {
        throw new Error("Expected parsed send_keys tool-call");
      }

      const input = JSON.parse(toolCall.input) as { value: string };
      expect(input).toEqual({ value: entityLiteralValue });
      assertEntityLiteralValue(input.value);
    });

    it(`${scenario.name} stream parser turns '&amp;lt;' into literal '&lt;' text`, async () => {
      const out = await runProtocolTextDeltaStream({
        protocol: scenario.protocol,
        tools,
        chunks: toCharacterChunks(scenario.rawModelOutput),
      });

      const toolCall = out.find(
        (
          part
        ): part is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> =>
          part.type === "tool-call" && part.toolName === "send_keys"
      );

      expect(toolCall).toBeTruthy();
      if (!toolCall) {
        throw new Error("Expected streamed send_keys tool-call");
      }

      const input = JSON.parse(toolCall.input) as { value: string };
      expect(input).toEqual({ value: entityLiteralValue });
      assertEntityLiteralValue(input.value);

      const deltas = out.filter(
        (
          part
        ): part is Extract<
          LanguageModelV3StreamPart,
          { type: "tool-input-delta" }
        > => part.type === "tool-input-delta" && part.id === toolCall.toolCallId
      );

      expect(deltas.length).toBeGreaterThan(0);

      const joined = deltas.map((part) => part.delta).join("");
      if (scenario.deltaJoinExpectation === "equal") {
        expect(joined).toBe(toolCall.input);
        const deltaInput = JSON.parse(joined) as { value: string };
        expect(deltaInput).toEqual({ value: entityLiteralValue });
        assertEntityLiteralValue(deltaInput.value);
        return;
      }

      expect(joined).not.toBe(toolCall.input);
      expect(joined.startsWith('{"value":"')).toBe(true);
    });
  }
});
