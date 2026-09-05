import type { JSONObject } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  balanceTags,
  balanceTagsHeuristic,
  dedupeShellStringTagsHeuristic,
  escapeInvalidLt,
  escapeInvalidLtHeuristic,
  getStringPropertyNames,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "../../../rxml/heuristics";
import { createIntermediateCall } from "../../../rxml/heuristics/engine";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";

describe("XML default heuristic edge coverage", () => {
  it("always applies close-tag normalization", () => {
    // Given
    const context = createIntermediateCall("tool", "<tag/>", {});

    // When
    const applies = normalizeCloseTagsHeuristic.applies(context);

    // Then
    expect(applies).toBe(true);
  });

  it.each([
    ["<tag>value</ tag>", { rawSegment: "<tag>value</tag>" }],
    ["<tag>value</tag>", {}],
  ])("normalizes close-tag input %s", (rawSegment, expected) => {
    // Given
    const context = createIntermediateCall("tool", rawSegment, {});

    // When
    const result = normalizeCloseTagsHeuristic.run(context);

    // Then
    expect(result).toEqual(expected);
  });

  it("always applies invalid-less-than escaping", () => {
    // Given
    const context = createIntermediateCall("tool", "text", {});

    // When
    const applies = escapeInvalidLtHeuristic.applies(context);

    // Then
    expect(applies).toBe(true);
  });

  it.each([
    ["a < b", { rawSegment: "a &lt; b" }],
    ["<tag>value</tag>", {}],
  ])("escapes invalid less-than input %s", (rawSegment, expected) => {
    // Given
    const context = createIntermediateCall("tool", rawSegment, {});

    // When
    const result = escapeInvalidLtHeuristic.run(context);

    // Then
    expect(result).toEqual(expected);
  });

  it.each([
    ["<", "&lt;"],
    ["<tag>", "<tag>"],
    ["</tag>", "</tag>"],
    ["<!notice>", "<!notice>"],
    ["<?instruction>", "<?instruction>"],
    ["<0>", "<0>"],
    ["<.invalid>", "&lt;.invalid>"],
  ])("escapes less-than utility input %s", (xml, expected) => {
    // Given / When
    const result = escapeInvalidLt(xml);

    // Then
    expect(result).toBe(expected);
  });

  it("uses raw input when balance metadata is absent", () => {
    // Given
    const context = createIntermediateCall("tool", "<outer><inner>", {});

    // When
    const result = balanceTagsHeuristic.run(context);

    // Then
    expect(result).toEqual({
      rawSegment: "<outer><inner></inner></outer>",
      reparse: true,
    });
  });

  it("applies balancing when an existing parse error needs repair", () => {
    // Given
    const context = createIntermediateCall("tool", "<outer><inner>", {});
    context.errors.push(new SyntaxError("incomplete XML"));

    // When
    const applies = balanceTagsHeuristic.applies(context);

    // Then
    expect(applies).toBe(true);
  });

  it("falls back to raw input when balancing metadata is non-string", () => {
    // Given
    const context = createIntermediateCall("tool", "<tag>", {});
    context.meta = { originalContent: 7 };

    // When
    const applies = balanceTagsHeuristic.applies(context);

    // Then
    expect(applies).toBe(false);
  });

  it("repairs raw input when balancing metadata is non-string", () => {
    // Given
    const context = createIntermediateCall("tool", "<tag>", {});
    context.meta = { originalContent: 7 };

    // When
    const result = balanceTagsHeuristic.run(context);

    // Then
    expect(result.rawSegment).toBe("<tag></tag>");
  });

  it("does not rebalance an error-free trailing opening tag", () => {
    // Given
    const context = createIntermediateCall("tool", "<tag>", {});

    // When
    const applies = balanceTagsHeuristic.applies(context);

    // Then
    expect(applies).toBe(false);
  });

  it.each([
    [
      {
        type: "object",
        properties: { command: { type: "array" } },
      },
      true,
    ],
    [{}, false],
    [{ type: "object", properties: { command: false } }, false],
    [{ type: "object", properties: { command: [] } }, false],
    [
      {
        type: "object",
        properties: { command: { type: "string" } },
      },
      false,
    ],
  ] satisfies readonly (readonly [ToolInputSchemaCandidate, boolean])[])(
    "classifies string-tag deduplication schema %#",
    (schema, expected) => {
      // Given / When
      const result = shouldDeduplicateStringTags(schema);

      // Then
      expect(result).toBe(expected);
    }
  );

  it("reports whether shell string-tag deduplication applies", () => {
    // Given
    const context = createIntermediateCall("shell", "<command/>", {
      type: "object",
      properties: { command: { type: "array" } },
    });

    // When
    const applies = dedupeShellStringTagsHeuristic.applies(context);

    // Then
    expect(applies).toBe(true);
  });

  it("deduplicates repeated string tags", () => {
    // Given
    const context = createIntermediateCall(
      "shell",
      "<name>first</name><name>last</name>",
      {
        type: "object",
        properties: {
          command: { type: "array" },
          name: { type: "string" },
        },
      }
    );

    // When
    const result = dedupeShellStringTagsHeuristic.run(context);

    // Then
    expect(result).toEqual({
      rawSegment: "<name>last</name>",
      reparse: true,
    });
  });

  it("returns no update when string tags are already unique", () => {
    // Given
    const context = createIntermediateCall("shell", "<name>once</name>", {
      type: "object",
      properties: {
        command: { type: "array" },
        name: { type: "string" },
      },
    });

    // When
    const result = dedupeShellStringTagsHeuristic.run(context);

    // Then
    expect(result).toEqual({});
  });

  it.each([
    [{ value: 1 }, true],
    ["value", false],
  ])("classifies schema repair input %#", (parsed, expected) => {
    // Given
    const context = createIntermediateCall("tool", "input", {});
    context.parsed = parsed;

    // When
    const applies = repairAgainstSchemaHeuristic.applies(context);

    // Then
    expect(applies).toBe(expected);
  });

  it("repairs an applicable parsed object in place", () => {
    // Given
    const context = createIntermediateCall("tool", "<items/>", {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    });
    context.parsed = { items: "single" };

    // When
    const result = repairAgainstSchemaHeuristic.run(context);

    // Then
    expect(result).toEqual({});
    expect(context.parsed).toEqual({ items: "single" });
  });

  it("returns no parsed update for an inapplicable repair context", () => {
    // Given
    const context = createIntermediateCall("tool", "text", {});
    context.parsed = "text";

    // When
    const result = repairAgainstSchemaHeuristic.run(context);

    // Then
    expect(result).toEqual({});
  });
});

describe("XML balancing edge coverage", () => {
  it.each([
    ["<", ""],
    ["<!unterminated", "<!unterminated"],
    ["<?unterminated", "<?unterminated"],
    ["<!complete>", "<!complete>"],
    ["<tag", "<tag"],
    ["</missing", ""],
    ["< outer >", "< outer ></outer>"],
    ["<empty />", "<empty />"],
    ["plain text", "plain text"],
    ["<outer><inner>value</outer>", "<outer><inner>value</inner></outer>"],
  ])("balances edge fragment %s", (xml, expected) => {
    // Given
    const fragment = xml;

    // When
    const result = balanceTags(fragment);

    // Then
    expect(result).toBe(expected);
  });
});

describe("schema repair edge coverage", () => {
  it.each([{}, null])(
    "returns no string property names for schema %#",
    (schema) => {
      // Given / When
      const names = getStringPropertyNames(schema);

      // Then
      expect(names).toEqual([]);
    }
  );

  it("preserves undefined repair input", () => {
    // Given
    const input = undefined;

    // When
    const result = repairParsedAgainstSchema(input, {});

    // Then
    expect(result).toBeUndefined();
  });

  it("preserves string repair input", () => {
    // Given
    const input = "value";

    // When
    const result = repairParsedAgainstSchema(input, {});

    // Then
    expect(result).toBe(input);
  });

  it("preserves object input when the schema has no properties", () => {
    // Given
    const input: JSONObject = { value: 1 };

    // When
    const result = repairParsedAgainstSchema(input, {});

    // Then
    expect(result).toBe(input);
  });

  it("ignores properties without object schemas", () => {
    // Given
    const input: JSONObject = { ignored: "value" };
    const schema: ToolInputSchema = {
      type: "object",
      properties: { ignored: false },
    };

    // When
    const result = repairParsedAgainstSchema(input, schema);

    // Then
    expect(result).toEqual({ ignored: "value" });
  });

  it.each(["single", ["one"]])(
    "preserves array-property value %# when no item repair applies",
    (items) => {
      // Given
      const input: JSONObject = { items };
      const schema: ToolInputSchema = {
        type: "object",
        properties: { items: { type: "array", items: { type: "string" } } },
      };

      // When
      const result = repairParsedAgainstSchema(input, schema);

      // Then
      expect(result).toEqual({ items });
    }
  );

  it("preserves undefined nested object properties", () => {
    // Given
    const input: JSONObject = { nested: undefined };
    const schema: ToolInputSchema = {
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
    };

    // When
    const result = repairParsedAgainstSchema(input, schema);

    // Then
    expect(result).toEqual({ nested: undefined });
  });

  it("repairs object values inside object arrays", () => {
    // Given
    const input: JSONObject = { items: [{ nested: { value: "ok" } }] };
    const schema: ToolInputSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          },
        },
      },
    };

    // When
    const result = repairParsedAgainstSchema(input, schema);

    // Then
    expect(result).toEqual({ items: [{ nested: { value: "ok" } }] });
  });

  it("parses XML strings into object array items", () => {
    // Given
    const input: JSONObject = {
      items: ["<step>build</step><status>done</status>"],
    };
    const schema: ToolInputSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    };

    // When
    const result = repairParsedAgainstSchema(input, schema);

    // Then
    expect(result).toEqual({ items: [{ step: "build", status: "done" }] });
  });

  it.each([
    [
      "<step>build</step><status>done</status>",
      { step: "build", status: "done" },
    ],
    ["<step>build</step>", "<step>build</step>"],
    ["<broken", "<broken"],
  ])("falls back after parser failure for %s", (xml, expected) => {
    // Given
    const itemSchema: ToolInputSchema = {
      type: "object",
      get properties(): never {
        throw new TypeError("schema properties unavailable");
      },
    };
    const schema: ToolInputSchema = {
      type: "object",
      properties: { items: { type: "array", items: itemSchema } },
    };
    const input: JSONObject = { items: [xml] };

    // When
    const result = repairParsedAgainstSchema(input, schema);

    // Then
    expect(result).toEqual({ items: [expected] });
  });
});
