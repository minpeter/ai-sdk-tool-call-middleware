import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  extractShorthandToolNameFromRaw,
  findImplicitCallOpenIndices,
  mergeArgsWithPartialParam,
  mergeParamValue,
  parseSingleFunctionCallXml,
  splitImplicitCallAndTail,
  stripLeadingCallCloseTags,
} from "../../../core/protocols/qwen3coder-call-parsing";

const tools: LanguageModelV4FunctionTool[] = [
  {
    type: "function",
    name: "search",
    description: "Search",
    inputSchema: {
      type: "object",
      properties: {
        QueryText: { type: "string" },
        raw: {},
      },
    },
  },
  {
    type: "function",
    name: "other",
    description: "Other",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
];

describe("Qwen call parsing helpers", () => {
  it.each([
    ['<function=" search &amp; find ">', "search & find"],
    ["<call='search'>", "search"],
    ["<invoke=other>", "other"],
    ["<function>", null],
    ['<tool="   ">', null],
  ])("extracts shorthand names from %s", (raw, expected) => {
    // Given raw call markup
    // When the shorthand name is extracted
    const result = extractShorthandToolNameFromRaw(raw);

    // Then only a non-empty decoded name is returned
    expect(result).toBe(expected);
  });

  it("merges first, repeated, and already-repeated parameter values", () => {
    // Given an empty argument accumulator
    const args = {};

    // When the same parameter is merged three times
    mergeParamValue(args, "query", "one");
    mergeParamValue(args, "query", "two");
    mergeParamValue(args, "query", "three");

    // Then insertion order is retained in one array
    expect(args).toEqual({ query: ["one", "two", "three"] });
  });

  it.each([
    [{ stable: "value" }, null, { stable: "value" }],
    [
      { stable: "value" },
      { name: "next", value: "one" },
      { stable: "value", next: "one" },
    ],
    [{ next: "one" }, { name: "next", value: "two" }, { next: ["one", "two"] }],
    [
      { next: ["one", "two"] },
      { name: "next", value: "three" },
      { next: ["one", "two", "three"] },
    ],
  ])(
    "merges a partial parameter without mutating completed arguments",
    (args, partial, expected) => {
      // Given completed arguments and an optional partial value
      // When progress arguments are assembled
      const result = mergeArgsWithPartialParam(args, partial);

      // Then the completed input is preserved and the partial value is appended
      expect(result).toEqual(expected);
    }
  );

  it("resolves attribute, shorthand, child, alternate-child, and fallback names", () => {
    // Given every supported tool-name location
    const inputs: Array<readonly [string, string | null]> = [
      ['<function name=" search "></function>', null],
      ["<call=other></call>", null],
      ["<function><name> search </name></function>", null],
      ["<function><tool_name>other</tool_name></function>", null],
      ["plain text", "other"],
    ];

    // When each call is parsed
    const names = inputs.map(
      ([xml, fallback]) =>
        parseSingleFunctionCallXml(xml, fallback, tools)?.toolName
    );

    // Then precedence resolves the intended name
    expect(names).toEqual(["search", "other", "search", "other", "other"]);
  });

  it("accepts fallback names when the opening token is not a call tag", () => {
    // Given opening tokens that have no tag name, no less-than, or are closes
    const inputs = ["plain>", "< >", "</function>"];

    // When a fallback identity is supplied
    const results = inputs.map((xml) =>
      parseSingleFunctionCallXml(xml, "search", tools)
    );

    // Then malformed opening tokens cannot override that identity
    expect(results).toEqual([
      { toolName: "search", args: {} },
      { toolName: "search", args: {} },
      { toolName: "search", args: {} },
    ]);
  });

  it("rejects empty and malformed name sources", () => {
    // Given malformed child names and empty fallback names
    const inputs = [
      ["plain text", null],
      ["<name", null],
      ["<name>missing close", null],
      ["</name><namespace>wrong</namespace>", "   "],
    ] as const;

    // When each candidate is parsed
    const results = inputs.map(([xml, fallback]) =>
      parseSingleFunctionCallXml(xml, fallback, tools)
    );

    // Then none becomes a call
    expect(results).toEqual([null, null, null, null]);
  });

  it("preserves raw JSON scalar and container boundaries as strings", () => {
    // Given arguments that look like every JSON value category
    const xml = `<function=search>
      <parameter=raw>null</parameter>
      <parameter=raw>true</parameter>
      <parameter=raw>-12.5e2</parameter>
      <parameter=raw>[1,{"x":false}]</parameter>
      <parameter=raw>{"nested":[null]}</parameter>
      <parameter=raw>"quoted"</parameter>
    </function>`;

    // When the function XML is parsed
    const result = parseSingleFunctionCallXml(xml, null, tools);

    // Then no JSON-looking value is coerced by call parsing
    expect(result).toEqual({
      toolName: "search",
      args: {
        raw: [
          "null",
          "true",
          "-12.5e2",
          '[1,{"x":false}]',
          '{"nested":[null]}',
          '"quoted"',
        ],
      },
    });
  });

  it("uses the selected tool schema to canonicalize property-named tags", () => {
    // Given a case-insensitive property tag from the selected tool schema
    const xml =
      "<function=search><querytext>value</querytext><id>ignored</id></function>";

    // When arguments are parsed
    const result = parseSingleFunctionCallXml(xml, null, tools);

    // Then only the selected schema property is recognized under its canonical key
    expect(result).toEqual({
      toolName: "search",
      args: { QueryText: "value" },
    });
  });

  it("handles skipped and truncated parameter tags", () => {
    // Given a nameless self-closing parameter and a truncated opener
    const xml = "<function=search><parameter/><parameter";

    // When the function is parsed
    const result = parseSingleFunctionCallXml(xml, null, tools);

    // Then malformed parameters do not create arguments
    expect(result).toEqual({ toolName: "search", args: {} });
  });

  it("accepts an end-of-input boundary on an implicit call opener", () => {
    // Given a call name ending exactly at the input boundary
    // When implicit starts are scanned
    const result = findImplicitCallOpenIndices("<call");

    // Then end of input is a valid tag-name boundary
    expect(result).toEqual([0]);
  });

  it("finds only valid implicit call openers", () => {
    // Given close tags, prefix collisions, shorthand, whitespace, and a terminal less-than
    const text =
      "</call><callback>< function=search><tool name='other'><invoke/><";

    // When implicit starts are scanned
    const result = findImplicitCallOpenIndices(text);

    // Then only supported opening-tag boundaries are returned
    expect(result).toEqual([17, 35, 54]);
  });

  it("strips every leading call close tag and retains the tail", () => {
    // Given mixed supported close tags before text
    const text = " \n</function> </tool_call>\t</invoke>tail";

    // When leading closes are removed
    const result = stripLeadingCallCloseTags(text);

    // Then parsing starts at the first non-close content
    expect(result).toBe("tail");
  });

  it("leaves text unchanged when no leading close tag exists", () => {
    // Given ordinary text
    const text = " prefix </function>";

    // When stripping is attempted
    const result = stripLeadingCallCloseTags(text);

    // Then non-leading markup is retained
    expect(result).toBe(text);
  });

  it("treats a missing indexed opening-tag character as an empty character", () => {
    // Given a string implementation with a sparse indexed opening tag
    const descriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "toLowerCase"
    );
    const originalToLowerCase = String.prototype.toLowerCase;
    let matchingCalls = 0;
    const sparseLower = {
      0: "<",
      length: 2,
      indexOf: (search: string): number => (search === "<" ? 0 : -1),
      slice: (): string => "",
    };
    Object.defineProperty(String.prototype, "toLowerCase", {
      configurable: true,
      writable: true,
      value(this: string): string | typeof sparseLower {
        if (String(this) === '<x name="search">' && matchingCalls === 0) {
          matchingCalls += 1;
          return sparseLower;
        }
        return Reflect.apply(originalToLowerCase, this, []);
      },
    });

    // When the opening tag name is read
    const result = parseSingleFunctionCallXml(
      '<x name="search">',
      "other",
      tools
    );
    if (descriptor) {
      Object.defineProperty(String.prototype, "toLowerCase", descriptor);
    }

    // Then the empty-character fallback leaves the supplied tool name intact
    expect(result).toEqual({ toolName: "search", args: {} });
  });

  it("handles an unsupported opening tag as unconsumed trailing text", () => {
    // Given markup that is not a supported call container
    const input = "<name>search</name>tail";

    // When its call boundary is calculated
    const result = splitImplicitCallAndTail(input, tools);

    // Then only the complete opening token is consumed
    expect(result).toEqual({
      callContent: "<name>",
      trailingText: "search</name>tail",
    });
  });

  it.each([
    ["plain tail", { callContent: "", trailingText: "plain tail" }],
    [
      "<function=search></function>tail",
      { callContent: "<function=search></function>", trailingText: "tail" },
    ],
    [
      "<function=search><parameter=raw>value</parameter>tail",
      {
        callContent: "<function=search><parameter=raw>value</parameter>",
        trailingText: "tail",
      },
    ],
    [
      "<function=search><parameter",
      { callContent: "<function=search>", trailingText: "<parameter" },
    ],
  ])("splits consumed call markup from trailing text", (input, expected) => {
    // Given a possible implicit call followed by a tail
    // When its consumed boundary is calculated
    const result = splitImplicitCallAndTail(input, tools);

    // Then only complete call markup is consumed
    expect(result).toEqual(expected);
  });
});
