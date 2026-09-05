import { afterEach, describe, expect, it, vi } from "vitest";

import type { RxmlValue } from "../../../rxml/builders/stringify";
import type { RXMLNode } from "../../../rxml/core/types";
import {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "../../../rxml/schema/coercion";
import type { ToolInputSchema } from "../../../schema/tool-input-schema";
import { coerceBySchema } from "../../../schema-coerce";

vi.mock("../../../schema-coerce", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
});

const PROTOTYPE_SENSITIVE_KEY_PATTERN = /Prototype-sensitive XML key/;

const leaf = (
  tagName: string,
  children: (RXMLNode | string)[] = [],
  attributes: Record<string, string | null> = {}
): RXMLNode => ({ attributes, children, tagName });

describe("RXML coercion branch coverage", () => {
  it("converts empty, text-only, element-only, and mixed nested content", () => {
    // Given
    const nodes: (RXMLNode | string)[] = [
      "ignored top-level text",
      leaf("empty"),
      leaf("simple", ["value"]),
      leaf("text", [" first ", " second "]),
      leaf("elements", [leaf("child")]),
      leaf("mixed", [" before ", leaf("child", ["value"]), " after "]),
      leaf("attributed", [leaf("child", [], { id: "1" })], { role: "group" }),
      leaf("deep", [leaf("branch", [leaf("tip", ["x"])])]),
      leaf("repeat", ["one"]),
      leaf("repeat", ["two"]),
      leaf("repeat", ["three"]),
    ];

    // When
    const result = domToObject(nodes, undefined);

    // Then
    expect(result).toEqual({
      empty: "",
      simple: "value",
      text: "first  second",
      elements: { child: "" },
      mixed: { "#text": "before  after", child: "value" },
      attributed: {
        "@_role": "group",
        child: { "@_id": "1", "#text": "" },
      },
      deep: { branch: { tip: "x" } },
      repeat: ["one", "two", "three"],
    });
  });

  it("rejects prototype-sensitive element names", () => {
    // Given
    const nodes = [leaf("constructor")];

    // When
    const action = () => domToObject(nodes, undefined);

    // Then
    expect(action).toThrowError(PROTOTYPE_SENSITIVE_KEY_PATTERN);
  });

  it("resolves present, absent, and invalid property schemas", () => {
    // Given
    const schema = {
      type: "object",
      properties: { present: { type: "string" } },
    } satisfies ToolInputSchema;

    // When
    const results = [
      getPropertySchema(schema, "present"),
      getPropertySchema(schema, "absent"),
      getPropertySchema({}, "absent"),
      getPropertySchema(false, "absent"),
      getPropertySchema(true, "absent"),
    ];

    // Then
    expect(results).toEqual([
      { type: "string" },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("returns a successfully coerced object", () => {
    // Given
    const value = { count: "2" };
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
    } satisfies ToolInputSchema;

    // When
    const result = coerceDomBySchema(value, schema);

    // Then
    expect(result).toEqual({ count: 2 });
  });

  it("wraps non-Error coercion failures with their normalized cause", () => {
    // Given
    const sentinel = Symbol("coercion sentinel");
    vi.mocked(coerceBySchema).mockImplementationOnce(() => {
      throw sentinel;
    });

    // When
    const action = () => coerceDomBySchema({ value: "input" }, undefined);

    // Then
    expect(action).toThrowError(
      expect.objectContaining({
        cause: expect.objectContaining({
          cause: sentinel,
          message: "Symbol(coercion sentinel)",
          name: "Error",
        }),
        message: "Failed to coerce DOM object by schema",
        name: "RXMLCoercionError",
      })
    );
  });

  it("rejects a non-object coercion result", () => {
    // Given
    vi.mocked(coerceBySchema).mockReturnValueOnce("not an object");

    // When
    const action = () => coerceDomBySchema({ value: "input" }, undefined);

    // Then
    expect(action).toThrowError(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: "RXML schema coercion returned a non-object value",
          name: "TypeError",
        }),
        message: "Failed to coerce DOM object by schema",
        name: "RXMLCoercionError",
      })
    );
  });

  it("collects string properties through object and array schema graphs", () => {
    // Given
    const shared = {
      type: "object",
      properties: { sharedText: { type: "string" } },
    } satisfies ToolInputSchema;
    const schema = {
      type: "object",
      properties: {
        direct: { type: "string" },
        scalar: { type: "number" },
        nested: shared,
        repeated: shared,
        arrays: {
          type: "array",
          items: [
            { type: "object", properties: { tupleText: { type: "string" } } },
          ],
          prefixItems: [
            { type: "object", properties: { prefixText: { type: "string" } } },
          ],
        },
        list: {
          type: "array",
          items: {
            type: "object",
            properties: { itemText: { type: "string" } },
          },
        },
        emptyList: { type: "array" },
      },
    } satisfies ToolInputSchema;

    // When
    const result = getStringTypedProperties(schema);

    // Then
    expect([...result].sort()).toEqual([
      "direct",
      "itemText",
      "prefixText",
      "sharedText",
      "tupleText",
    ]);
  });

  it.each([false, true, undefined])("ignores empty schema %s", (schema) => {
    // Given
    const definition = schema;

    // When
    const result = getStringTypedProperties(definition);

    // Then
    expect(result).toEqual(new Set());
  });

  it("preserves a non-array value during array normalization", () => {
    // Given
    const value = " unchanged ";

    // When
    const result = processArrayContent(value, undefined, "#text");

    // Then
    expect(result).toBe(value);
  });

  it.each([
    {
      schema: { type: "string" } satisfies ToolInputSchema,
      expected: ["plain", "record", "7", "[object Object]"],
    },
    {
      schema: { type: "number" } satisfies ToolInputSchema,
      expected: ["plain", "record", 7, { nested: "value" }],
    },
  ])(
    "normalizes heterogeneous array items for $schema.type schemas",
    ({ schema, expected }) => {
      // Given
      const value: RxmlValue = [
        " plain ",
        { "#text": " record " },
        { "#text": 7 },
        { nested: "value" },
      ];

      // When
      const result = processArrayContent(value, schema, "#text");

      // Then
      expect(result).toEqual(expected);
    }
  );

  it("wraps a non-indexed object instead of treating it as a tuple", () => {
    // Given
    const value = { "1": "one", "3": "three" };

    // When
    const result = processIndexedTuple(value, "#text");

    // Then
    expect(result).toEqual([value]);
  });

  it("normalizes every indexed tuple value shape", () => {
    // Given
    const value = {
      "0": { "#text": " text " },
      "1": { "#text": 7 },
      "2": " plain ",
      "3": { nested: "value" },
    } satisfies Record<string, RxmlValue>;

    // When
    const result = processIndexedTuple(value, "#text");

    // Then
    expect(result).toEqual(["text", 7, "plain", { nested: "value" }]);
  });
});
