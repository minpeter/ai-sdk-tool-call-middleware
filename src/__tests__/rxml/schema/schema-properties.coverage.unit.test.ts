import { describe, expect, it, vi } from "vitest";
import type { RxmlValue } from "../../../rxml/builders/stringify";
import {
  backfillStringProperties,
  processParsedProperties,
} from "../../../rxml/core/schema-properties";
import { RXMLDuplicateStringTagError } from "../../../rxml/errors/types";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";

const emptyContext = {
  duplicateKeys: new Set<string>(),
  options: {},
  originalContent: new Map<string, string>(),
  schema: undefined,
  textNodeName: "#text",
  xml: "",
};

describe("schema property processing coverage", () => {
  it("normalizes scalar, item-wrapper, tuple, and ordinary object values", () => {
    // Given
    const parsed = {
      array: [" one ", { "#text": " two " }],
      empty: {},
      itemArray: {
        item: [{ "#text": " 2 " }, " word ", null, { "#text": "1e999" }],
      },
      itemNumber: { item: 7 },
      itemString: { item: " 3.5 " },
      nonTuple: { 1: "one" },
      ordinary: { alpha: true },
      text: { "#text": false, attribute: "ignored" },
      tuple: { 0: { "#text": " first " }, 1: " 2 ", 2: false },
      whitespace: "  not numeric  ",
    };

    // When
    const result = processParsedProperties(parsed, emptyContext);

    // Then
    expect(result).toEqual({
      array: ["one", "two"],
      empty: {},
      itemArray: [2, "word", null, "1e999"],
      itemNumber: 7,
      itemString: 3.5,
      nonTuple: { 1: "one" },
      ordinary: { alpha: true },
      text: false,
      tuple: ["first", "2", false],
      whitespace: "not numeric",
    });
  });

  it("uses duplicate placeholder originals and direct duplicate values", () => {
    // Given
    const parsed = {
      direct: [" first ", "second"],
      restored: ["__RXML_PLACEHOLDER_0__", "discarded"],
    };
    const context = {
      ...emptyContext,
      duplicateKeys: new Set(["direct", "restored"]),
      originalContent: new Map([
        ["__RXML_PLACEHOLDER_0__", "<raw>value</raw>"],
      ]),
      schema: {
        type: "object",
        properties: {
          direct: { type: "string" },
          restored: { type: "string" },
        },
      } satisfies ToolInputSchema,
    };

    // When
    const result = processParsedProperties(parsed, context);

    // Then
    expect(result).toEqual({
      direct: " first ",
      restored: "<raw>value</raw>",
    });
  });

  it("throws for repeated string values by default", () => {
    // Given
    const context = {
      ...emptyContext,
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
      } satisfies ToolInputSchema,
    };

    // When
    const act = () =>
      processParsedProperties({ value: ["first", "second"] }, context);

    // Then
    expect(act).toThrow(RXMLDuplicateStringTagError);
  });

  it("reports repeated strings and keeps the first value when configured", () => {
    // Given
    const onError = vi.fn();
    const context = {
      ...emptyContext,
      options: { onError, throwOnDuplicateStringTags: false },
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
      } satisfies ToolInputSchema,
    };

    // When
    const result = processParsedProperties(
      {
        value: [{ "#text": "first" }, { "#text": 2 }, "third", false],
      },
      context
    );

    // Then
    expect(result.value).toBe("first");
    expect(onError).toHaveBeenCalledWith(
      "RXML: Duplicate string tags for <value> detected; using first occurrence.",
      { occurrences: 4, tag: "value" }
    );
  });

  it("handles empty string arrays without an error callback", () => {
    // Given
    const context = {
      ...emptyContext,
      options: { throwOnDuplicateStringTags: false },
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
      } satisfies ToolInputSchema,
    };

    // When
    const result = processParsedProperties({ value: [] }, context);

    // Then
    expect(result.value).toBe("");
  });

  it("resolves scalar placeholders and raw XML before trimming", () => {
    // Given
    const directPlaceholderSchema = {} satisfies ToolInputSchema;
    Object.defineProperty(directPlaceholderSchema, "jsonSchema", {
      enumerable: true,
      value: { type: "string" } satisfies ToolInputSchema,
    });
    const schema = {
      type: "object",
      properties: {
        directPlaceholder: directPlaceholderSchema,
        objectPlaceholder: { type: "string" },
        raw: { type: "string" },
      },
    } satisfies ToolInputSchema;
    const context = {
      ...emptyContext,
      originalContent: new Map([
        ["__RXML_PLACEHOLDER_DIRECT__", " direct original "],
        ["__RXML_PLACEHOLDER_OBJECT__", " object original "],
      ]),
      schema,
      xml: "<raw>  <nested>value</nested>  </raw>",
    };

    // When
    const result = processParsedProperties(
      {
        directPlaceholder: "__RXML_PLACEHOLDER_DIRECT__",
        objectPlaceholder: { "#text": "__RXML_PLACEHOLDER_OBJECT__" },
        raw: "parsed",
      },
      context
    );

    // Then
    expect(result).toEqual({
      directPlaceholder: " direct original ",
      objectPlaceholder: " object original ",
      raw: "  <nested>value</nested>  ",
    });
  });

  it("falls back safely for missing placeholders and malformed property schemas", () => {
    // Given
    const cyclicProperty = {} satisfies ToolInputSchema;
    Object.defineProperty(cyclicProperty, "jsonSchema", {
      enumerable: true,
      value: cyclicProperty,
    });
    const emptyStringSchema: ToolInputSchemaCandidate = "";
    const nullSchema: ToolInputSchemaCandidate = null;
    const numericSchema: ToolInputSchemaCandidate = 0;
    const properties = {
      absentPlaceholder: { type: "string" },
      cyclic: cyclicProperty,
      falseSchema: false,
      missingText: { type: "string" },
      nonStringText: { type: "string" },
      trueSchema: true,
    } satisfies ToolInputSchema["properties"];
    Object.defineProperty(properties, "emptyString", {
      enumerable: true,
      value: emptyStringSchema,
    });
    Object.defineProperty(properties, "nullSchema", {
      enumerable: true,
      value: nullSchema,
    });
    Object.defineProperty(properties, "numericSchema", {
      enumerable: true,
      value: numericSchema,
    });
    const parsed = {
      absentPlaceholder: "__RXML_PLACEHOLDER_ABSENT__",
      cyclic: " cyclic ",
      emptyString: " empty string ",
      falseSchema: " false ",
      missingText: { other: true },
      nonStringText: { "#text": 9 },
      nullSchema: " null ",
      numericSchema: " zero ",
      trueSchema: " true ",
    };
    const context = {
      ...emptyContext,
      schema: {
        type: "object",
        properties,
      } satisfies ToolInputSchema,
    };

    // When
    const result = processParsedProperties(parsed, context);

    // Then
    expect(result).toEqual({
      absentPlaceholder: "__RXML_PLACEHOLDER_ABSENT__",
      cyclic: "cyclic",
      emptyString: "empty string",
      falseSchema: "false",
      missingText: { other: true },
      nonStringText: 9,
      nullSchema: "null",
      numericSchema: "zero",
      trueSchema: "true",
    });
  });

  it("falls through a duplicate placeholder whose original is missing", () => {
    // Given
    const context = {
      ...emptyContext,
      duplicateKeys: new Set(["value"]),
      options: { throwOnDuplicateStringTags: false },
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
      } satisfies ToolInputSchema,
    };

    // When
    const result = processParsedProperties(
      { value: ["__RXML_PLACEHOLDER_MISSING__"] },
      context
    );

    // Then
    expect(result.value).toBe("__RXML_PLACEHOLDER_MISSING__");
  });

  it("backfills only absent string properties with raw XML content", () => {
    // Given
    const args: Record<string, RxmlValue> = { existing: "kept" };

    // When
    backfillStringProperties(
      args,
      new Set(["existing", "found", "missing"]),
      "<existing>replaced</existing><found><b>raw</b></found>"
    );

    // Then
    expect(args).toEqual({ existing: "kept", found: "<b>raw</b>" });
  });
});
