import type {
  JSONSchema7Definition,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  extractQwen3CoderToolNameFromMarkup,
  parseQwen3CoderToolParserToolCallSegment,
} from "../../../core/protocols/qwen3coder-call-parsing";
import { CALL_BLOCK_RE } from "../../../core/protocols/qwen3coder-call-syntax";

interface CoverageToolDefinition {
  readonly description: string;
  readonly name: string;
  readonly properties: Readonly<Record<string, JSONSchema7Definition>>;
}

const coverageToolDefinitions: readonly CoverageToolDefinition[] = [
  {
    name: "search",
    description: "Search",
    properties: { QueryText: { type: "string" }, raw: {} },
  },
  {
    name: "other",
    description: "Other",
    properties: { id: { type: "string" } },
  },
];

const tools: LanguageModelV4FunctionTool[] = coverageToolDefinitions.map(
  ({ description, name, properties }) => ({
    type: "function",
    name,
    description,
    inputSchema: { type: "object", properties },
  })
);

const wrap = (body: string, attributes = ""): string =>
  `<tool_call${attributes}>${body}</tool_call>`;

describe("Qwen tool-call segment parsing", () => {
  it("uses the implicit block start fallback for a sparse internal index", () => {
    // Given a sparse result from the internal index accumulator
    const pushDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "push"
    );
    if (!pushDescriptor) {
      throw new TypeError("Array.prototype.push descriptor is unavailable");
    }
    Object.defineProperty(Array.prototype, "push", {
      configurable: true,
      writable: true,
      value<T>(this: T[], ...items: T[]): number {
        if (items.length === 1 && typeof items[0] === "number") {
          this.length += 1;
          return this.length;
        }
        for (const item of items) {
          this[this.length] = item;
        }
        return this.length;
      },
    });

    try {
      // When an implicit call is parsed
      const result = parseQwen3CoderToolParserToolCallSegment(
        wrap("<function=search>"),
        tools
      );

      // Then the defensive zero start still recovers the call
      expect(result).toEqual([{ toolName: "search", args: {} }]);
    } finally {
      Object.defineProperty(Array.prototype, "push", pushDescriptor);
    }
  });

  it("rejects extraction when the located closing token disappears", () => {
    // Given a close-tag search whose defensive second lookup fails
    const originalLastIndexOf = String.prototype.lastIndexOf;
    const lastIndexOf = vi
      .spyOn(String.prototype, "lastIndexOf")
      .mockImplementation(function (this: string, searchString, position) {
        if (searchString === "</tool_call") {
          return -1;
        }
        return Reflect.apply(originalLastIndexOf, this, [
          searchString,
          position,
        ]);
      });

    // When a structurally complete segment is extracted
    const result = parseQwen3CoderToolParserToolCallSegment(
      "<tool_call></tool_call>",
      tools
    );
    lastIndexOf.mockRestore();

    // Then the inconsistent close location is rejected
    expect(result).toBeNull();
  });

  it("rejects extraction when the final closing angle bracket disappears", () => {
    // Given a final close whose angle-bracket lookup defensively fails
    const originalIndexOf = String.prototype.indexOf;
    const indexOf = vi
      .spyOn(String.prototype, "indexOf")
      .mockImplementation(function (this: string, searchString, position) {
        if (searchString === ">" && position !== undefined && position > 0) {
          return -1;
        }
        return Reflect.apply(originalIndexOf, this, [searchString, position]);
      });

    // When a structurally complete segment is extracted
    const result = parseQwen3CoderToolParserToolCallSegment(
      "<tool_call></tool_call>",
      tools
    );
    indexOf.mockRestore();

    // Then the inconsistent close boundary is rejected
    expect(result).toBeNull();
  });

  it.each(["", "<tool_call>", "</tool_call>", "<tool_call>missing close"])(
    "rejects malformed outer segment %j",
    (segment) => {
      // Given malformed outer markup
      // When the segment is parsed
      const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

      // Then it is rejected
      expect(result).toBeNull();
    }
  );

  it("uses the final outer close when an argument contains close-tag text", () => {
    // Given a literal early tool-call close inside a parameter
    const segment = wrap(
      "<function=search><parameter=raw>before </tool_call> after</parameter></function>"
    );

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then extraction extends to the final outer close
    expect(result).toEqual([
      { toolName: "search", args: { raw: "before </tool_call> after" } },
    ]);
  });

  it("parses leading implicit, closed, and trailing implicit calls in order", () => {
    // Given all call block styles in one outer container
    const segment = wrap(
      "<call=search><parameter=raw>lead" +
        "<function=other><parameter=id>closed</parameter></function>" +
        "<invoke=search><querytext>tail</querytext>"
    );

    // When the outer segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then each block is parsed in source order
    expect(result).toEqual([
      { toolName: "search", args: { raw: "lead" } },
      { toolName: "other", args: { id: "closed" } },
      { toolName: "search", args: { QueryText: "tail" } },
    ]);
  });

  it("ignores malformed regex matches at the closed-call boundary", () => {
    // Given an impossible regex result with neither matched text nor an index
    CALL_BLOCK_RE.lastIndex = 0;
    const malformedMatch = CALL_BLOCK_RE.exec("<function=search></function>");
    if (!malformedMatch) {
      throw new Error("Expected fixture regex to match");
    }
    Object.defineProperty(malformedMatch, "0", { value: undefined });
    Object.defineProperty(malformedMatch, "index", { value: undefined });
    const matchAllDescriptor = Object.getOwnPropertyDescriptor(
      CALL_BLOCK_RE,
      Symbol.matchAll
    );
    Object.defineProperty(CALL_BLOCK_RE, Symbol.matchAll, {
      configurable: true,
      *value() {
        yield malformedMatch;
      },
    });

    // When closed matches are parsed
    const result = parseQwen3CoderToolParserToolCallSegment(
      wrap("<function=search></function>"),
      tools
    );
    if (matchAllDescriptor) {
      Object.defineProperty(CALL_BLOCK_RE, Symbol.matchAll, matchAllDescriptor);
    } else {
      Reflect.deleteProperty(CALL_BLOCK_RE, Symbol.matchAll);
    }
    CALL_BLOCK_RE.lastIndex = 0;

    // Then the malformed closed match is skipped and implicit parsing recovers it
    expect(result).toEqual([{ toolName: "search", args: {} }]);
  });

  it("returns closed calls when trailing prose has no call opener", () => {
    // Given a closed call followed by ordinary text
    const segment = wrap("<function=other></function> trailing prose");

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then the valid closed call survives
    expect(result).toEqual([{ toolName: "other", args: {} }]);
  });

  it("returns closed calls when a malformed trailing implicit call cannot resolve a name", () => {
    // Given a valid closed call followed by a nameless implicit call
    const segment = wrap("<function=other></function><function>");

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then the complete call is retained as fallback
    expect(result).toEqual([{ toolName: "other", args: {} }]);
  });

  it("rejects a nameless closed call instead of returning a partial call list", () => {
    // Given one closed call that cannot resolve a tool name
    const segment = wrap("<function></function>");

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then the entire segment is rejected
    expect(result).toBeNull();
  });

  it("splits multiple unclosed implicit calls", () => {
    // Given adjacent calls whose close tags were omitted
    const segment = wrap(
      "<function=search><parameter=raw>one<call=other><parameter=id>two"
    );

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then the next opener terminates the prior call
    expect(result).toEqual([
      { toolName: "search", args: { raw: "one" } },
      { toolName: "other", args: { id: "two" } },
    ]);
  });

  it("falls back from inner content to the outer tool name", () => {
    // Given an outer name attribute and parameter-only inner content
    const segment = wrap("<parameter=raw>value</parameter>", ' name="search"');

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then the outer name supplies the call identity
    expect(result).toEqual([{ toolName: "search", args: { raw: "value" } }]);
  });

  it("returns null when neither inner nor outer markup supplies a name", () => {
    // Given a structurally complete but nameless outer segment
    const segment = wrap("plain text");

    // When the segment is parsed
    const result = parseQwen3CoderToolParserToolCallSegment(segment, tools);

    // Then no call is fabricated
    expect(result).toBeNull();
  });

  it("does not salvage whitespace-only names", () => {
    // Given a matched child-name shape containing no name
    const markup = "<name>   </name>";

    // When salvage is attempted
    const result = extractQwen3CoderToolNameFromMarkup(markup);

    // Then no name is returned
    expect(result).toBeUndefined();
  });
});
