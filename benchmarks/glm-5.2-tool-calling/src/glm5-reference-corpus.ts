import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import type { Glm5DecodedCall } from "./glm5-reference-decoders";

export type Glm5CorpusFamily =
  | "canonical-valid"
  | "format-variant"
  | "missing-close"
  | "raw-structural-marker"
  | "unsafe-or-ambiguous"
  | "no-call"
  | "parallel";

export interface Glm5ReferenceCorpusCase {
  expectedCalls: Glm5DecodedCall[];
  family: Glm5CorpusFamily;
  id: string;
  note: string;
  text: string;
}

export const GLM5_REFERENCE_CORPUS_TOOLS: LanguageModelV4FunctionTool[] = [
  {
    description: "Echo one string exactly.",
    inputSchema: {
      additionalProperties: false,
      properties: { message: { type: "string" } },
      required: ["message"],
      type: "object",
    },
    name: "echo",
    type: "function",
  },
  {
    description: "Add two integers.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        left: { type: "integer" },
        right: { type: "integer" },
      },
      required: ["left", "right"],
      type: "object",
    },
    name: "add",
    type: "function",
  },
  {
    description: "Accept nested structured data.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        config: {
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            mode: { type: "string" },
          },
          required: ["mode", "enabled"],
          type: "object",
        },
        items: { items: { type: "integer" }, type: "array" },
      },
      required: ["items", "config"],
      type: "object",
    },
    name: "aggregate",
    type: "function",
  },
  {
    description: "Return service health.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    name: "ping",
    type: "function",
  },
];

const echo = (message: string): Glm5DecodedCall => ({
  arguments: { message },
  name: "echo",
});

export const GLM5_REFERENCE_CORPUS: Glm5ReferenceCorpusCase[] = [
  {
    expectedCalls: [echo("hello 🚀")],
    family: "canonical-valid",
    id: "canonical-string-unicode",
    note: "Official raw-string argument grammar with Unicode.",
    text: "Before <tool_call>echo<arg_key>message</arg_key><arg_value>hello 🚀</arg_value></tool_call> after.",
  },
  {
    expectedCalls: [{ arguments: { left: 7, right: 11 }, name: "add" }],
    family: "canonical-valid",
    id: "canonical-number-coercion",
    note: "Official raw scalar values coerced using the tool schema.",
    text: "<tool_call>add<arg_key>left</arg_key><arg_value>7</arg_value><arg_key>right</arg_key><arg_value>11</arg_value></tool_call>",
  },
  {
    expectedCalls: [
      {
        arguments: {
          config: { enabled: true, mode: "safe" },
          items: [1, 2, 3],
        },
        name: "aggregate",
      },
    ],
    family: "canonical-valid",
    id: "canonical-nested-json",
    note: "Official tojson-style non-string arguments.",
    text: '<tool_call>aggregate<arg_key>items</arg_key><arg_value>[1,2,3]</arg_value><arg_key>config</arg_key><arg_value>{"mode":"safe","enabled":true}</arg_value></tool_call>',
  },
  {
    expectedCalls: [{ arguments: {}, name: "ping" }],
    family: "canonical-valid",
    id: "canonical-zero-argument",
    note: "Official grammar permits a call without argument tags.",
    text: "<tool_call>ping</tool_call>",
  },
  {
    expectedCalls: [echo("case tolerant")],
    family: "format-variant",
    id: "variant-tag-case",
    note: "Exact-case references reject tags that production tolerates.",
    text: "<TOOL_CALL>echo<ARG_KEY>message</ARG_KEY><ARG_VALUE>case tolerant</ARG_VALUE></TOOL_CALL>",
  },
  {
    expectedCalls: [echo("space tolerant")],
    family: "format-variant",
    id: "variant-tag-whitespace",
    note: "Whitespace inside structural tags is a bounded production recovery.",
    text: "< tool_call >echo< arg_key >message</ arg_key >< arg_value >space tolerant</ arg_value ></ tool_call >",
  },
  {
    expectedCalls: [echo("missing outer")],
    family: "missing-close",
    id: "missing-tool-call-close",
    note: "Final outer close is absent at end of generation.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>missing outer</arg_value>",
  },
  {
    expectedCalls: [echo("missing value close")],
    family: "missing-close",
    id: "missing-arg-value-close",
    note: "Final value close is absent immediately before the outer close.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>missing value close</tool_call>",
  },
  {
    expectedCalls: [echo("missing key close")],
    family: "missing-close",
    id: "missing-arg-key-close",
    note: "Argument key close is absent but the next value tag is unambiguous.",
    text: "<tool_call>echo<arg_key>message<arg_value>missing key close</arg_value></tool_call>",
  },
  {
    expectedCalls: [echo("literal </tool_call> marker")],
    family: "raw-structural-marker",
    id: "raw-outer-close-in-string",
    note: "Official raw strings are unescaped, requiring close-candidate adjudication.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>literal </tool_call> marker</arg_value></tool_call>",
  },
  {
    expectedCalls: [echo("literal </arg_value> marker")],
    family: "raw-structural-marker",
    id: "raw-value-close-in-string",
    note: "A value-close marker can be literal when only a later close yields a schema-valid call.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>literal </arg_value> marker</arg_value></tool_call>",
  },
  {
    expectedCalls: [],
    family: "unsafe-or-ambiguous",
    id: "duplicate-key",
    note: "Duplicate keys are ambiguous and the production parser rejects them.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>first</arg_value><arg_key>message</arg_key><arg_value>second</arg_value></tool_call>",
  },
  {
    expectedCalls: [],
    family: "unsafe-or-ambiguous",
    id: "prototype-sensitive-key",
    note: "Prototype-sensitive keys must fail closed.",
    text: "<tool_call>echo<arg_key>__proto__</arg_key><arg_value>{}</arg_value></tool_call>",
  },
  {
    expectedCalls: [],
    family: "unsafe-or-ambiguous",
    id: "unknown-tool",
    note: "Unknown tool names must not become calls.",
    text: "<tool_call>delete_everything<arg_key>confirm</arg_key><arg_value>true</arg_value></tool_call>",
  },
  {
    expectedCalls: [],
    family: "unsafe-or-ambiguous",
    id: "nested-tool-call",
    note: "Nested calls are structurally ambiguous and must fail closed.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>outer <tool_call>ping</tool_call></arg_value></tool_call>",
  },
  {
    expectedCalls: [],
    family: "no-call",
    id: "ordinary-prose",
    note: "Ordinary prose contains no structural marker.",
    text: "Explain what a function call is without calling any function.",
  },
  {
    expectedCalls: [],
    family: "no-call",
    id: "incomplete-marker-in-prose",
    note: "A quoted opening marker in documentation is not a complete call.",
    text: 'The token "<tool_call>" begins the example syntax.',
  },
  {
    expectedCalls: [],
    family: "no-call",
    id: "complete-call-code-example",
    note: "Adversarial prose containing a complete valid-looking call tests false positives.",
    text: "Example only, do not execute: `<tool_call>ping</tool_call>`.",
  },
  {
    expectedCalls: [
      echo("first"),
      { arguments: { left: 2, right: 3 }, name: "add" },
    ],
    family: "parallel",
    id: "adjacent-parallel-calls",
    note: "Official grammar permits adjacent independent calls.",
    text: "<tool_call>echo<arg_key>message</arg_key><arg_value>first</arg_value></tool_call><tool_call>add<arg_key>left</arg_key><arg_value>2</arg_value><arg_key>right</arg_key><arg_value>3</arg_value></tool_call>",
  },
];
