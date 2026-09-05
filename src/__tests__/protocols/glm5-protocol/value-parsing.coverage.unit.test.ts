import type { JSONSchema7, JSONValue } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  createGlm5Args,
  isIncrementallyStreamableGlm5StringSchema,
  normalizeGlm5StringValue,
  parseCompletedGlm5Value,
  safeAssignGlm5Arg,
} from "../../../core/protocols/glm5-value-parsing";
import type { ToolInputSchema } from "../../../schema/tool-input-schema";

const coerceBySchemaMock = vi.hoisted(() => vi.fn());

vi.mock("../../../schema-coerce", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../schema-coerce")>();
  coerceBySchemaMock.mockImplementation(original.coerceBySchema);
  return { ...original, coerceBySchema: coerceBySchemaMock };
});

describe("GLM-5 value construction and normalization", () => {
  it("creates a prototype-free argument object", () => {
    // Given / When
    const args = createGlm5Args();

    // Then
    expect(Object.getPrototypeOf(args)).toBeNull();
  });

  it.each([
    [{ complete: true, mode: "layout", value: "\n  hello\n  " }, "hello"],
    [{ complete: false, mode: "layout", value: "\n  hello  \n" }, "hello"],
    [{ complete: true, mode: "preserve", value: "\n hello \n" }, "\n hello \n"],
    [{ complete: false, mode: "preserve", value: "hello\ud800" }, "hello"],
    [{ complete: false, mode: "preserve", value: "hello" }, "hello"],
  ] satisfies readonly (readonly [
    Parameters<typeof normalizeGlm5StringValue>[0],
    string,
  ])[])("normalizes string boundary %#", (options, expected) => {
    // Given / When
    const result = normalizeGlm5StringValue(options);

    // Then
    expect(result).toBe(expected);
  });
});

describe("GLM-5 incremental string schema classification", () => {
  it("accepts a dynamically unwrapped primitive string schema", () => {
    // Given
    let reads = 0;
    const schema: ToolInputSchema = {
      get jsonSchema(): ToolInputSchema["jsonSchema"] {
        reads += 1;
        return reads === 1 ? { type: "string" } : true;
      },
    };

    // When
    const result = isIncrementallyStreamableGlm5StringSchema(schema);

    // Then
    expect(result).toBe(true);
  });

  it.each([
    [undefined, false],
    [{ type: "number" }, false],
    [{ type: "string" }, true],
    [{ type: "string", const: "fixed" }, false],
    [{ type: "string", enum: ["a", "b"] }, false],
  ] satisfies readonly (readonly [JSONSchema7 | undefined, boolean])[])(
    "classifies schema %#",
    (schema, expected) => {
      // Given / When
      const result = isIncrementallyStreamableGlm5StringSchema(schema);

      // Then
      expect(result).toBe(expected);
    }
  );
});

describe("GLM-5 safe argument assignment", () => {
  it("assigns a safe unique JSON value", () => {
    // Given
    const args = createGlm5Args();
    const recoveries: string[] = [];

    // When
    const assigned = safeAssignGlm5Arg(args, "count", 2, recoveries);

    // Then
    expect(assigned).toBe(true);
    expect(args).toEqual({ count: 2 });
    expect(recoveries).toEqual([]);
  });

  it.each([
    ["__proto__", 1, "rejected-prototype-sensitive-key"],
    ["constructor", 1, "rejected-prototype-sensitive-key"],
    ["value", { prototype: true }, "rejected-prototype-sensitive-value"],
  ] satisfies readonly (readonly [string, JSONValue, string])[])(
    "rejects unsafe assignment %#",
    (key, value, recovery) => {
      // Given
      const args = createGlm5Args();
      const recoveries: string[] = [];

      // When
      const assigned = safeAssignGlm5Arg(args, key, value, recoveries);

      // Then
      expect(assigned).toBe(false);
      expect(recoveries).toEqual([recovery]);
    }
  );

  it("rejects duplicate argument keys", () => {
    // Given
    const args = createGlm5Args();
    args.value = 1;
    const recoveries: string[] = [];

    // When
    const assigned = safeAssignGlm5Arg(args, "value", 2, recoveries);

    // Then
    expect(assigned).toBe(false);
    expect(args.value).toBe(1);
    expect(recoveries).toEqual(["rejected-duplicate-key"]);
  });
});

describe("GLM-5 completed value parsing", () => {
  it.each([
    ["[]", { type: "array" }, false],
    ["text", { type: "string" }, false],
    ["text", undefined, false],
  ] satisfies readonly (readonly [string, JSONSchema7 | undefined, boolean])[])(
    "rejects non-JSON coercion output for boundary %#",
    (rawValue, schema, recoverReferences) => {
      // Given
      coerceBySchemaMock.mockReturnValueOnce(undefined);

      // When
      const result = parseCompletedGlm5Value(
        rawValue,
        schema,
        "preserve",
        recoverReferences
      );

      // Then
      expect(result).toEqual({ ok: false });
    }
  );

  it.each([
    [
      " hello ",
      { type: "string" },
      "layout",
      false,
      { ok: true, value: " hello " },
    ],
    [
      "<prototype>x</prototype>",
      { type: "string" },
      "preserve",
      false,
      { ok: false },
    ],
    [
      '[1,"2"]',
      { type: "array", items: { type: "number" } },
      "preserve",
      false,
      { ok: true, value: [1, 2] },
    ],
    ["true", { type: "boolean" }, "preserve", false, { ok: true, value: true }],
    ["2", { type: "integer" }, "preserve", false, { ok: true, value: 2 }],
    ["null", { type: "null" }, "preserve", false, { ok: true, value: null }],
    ["2.5", { type: "number" }, "preserve", false, { ok: true, value: 2.5 }],
    [
      '{"count":"2"}',
      { type: "object", properties: { count: { type: "number" } } },
      "preserve",
      false,
      { ok: true, value: { count: 2 } },
    ],
    ["invalid", { type: "array" }, "preserve", false, { ok: false }],
    [
      '{"constructor":{"polluted":true}}',
      { type: "object", additionalProperties: true },
      "preserve",
      false,
      { ok: false },
    ],
    [
      "response.data[0]",
      { type: "object", additionalProperties: true },
      "preserve",
      true,
      {
        ok: true,
        recovery: "recovered-opaque-object-reference",
        value: "response.data[0]",
      },
    ],
    [
      "response.data",
      { type: "object", additionalProperties: true },
      "preserve",
      false,
      { ok: false },
    ],
    [
      "constructor.value",
      { type: "object", additionalProperties: true },
      "preserve",
      true,
      { ok: false },
    ],
    ["{}", undefined, "preserve", false, { ok: true, value: {} }],
    ["[]", undefined, "preserve", false, { ok: true, value: [] }],
    ["true", undefined, "preserve", false, { ok: true, value: true }],
    ["<prototype>x</prototype>", undefined, "preserve", false, { ok: false }],
  ] satisfies readonly (readonly [
    string,
    JSONSchema7 | undefined,
    "layout" | "preserve",
    boolean,
    ReturnType<typeof parseCompletedGlm5Value>,
  ])[])(
    "parses completed value %#",
    (rawValue, schema, normalization, recoverReferences, expected) => {
      // Given / When
      const result = parseCompletedGlm5Value(
        rawValue,
        schema,
        normalization,
        recoverReferences
      );

      // Then
      expect(result).toEqual(expected);
    }
  );
});
