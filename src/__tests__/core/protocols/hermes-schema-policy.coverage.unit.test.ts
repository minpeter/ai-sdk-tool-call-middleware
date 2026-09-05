import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { JSONSchema7Type } from "json-schema";
import { describe, expect, it } from "vitest";
import {
  ArgumentKeyPolicyError,
  applyArgumentKeyPolicy,
  containsPrototypeSensitiveArgumentKey,
  extractArgumentKeyPolicy,
  hasPrototypeSensitiveKeyInJsonLikeObject,
  isArgumentKeyPolicyError,
} from "../../../core/protocols/hermes-argument-key-policy";
import { argumentValueMatchesSchemaKeyShape } from "../../../core/protocols/hermes-argument-schema";
import type {
  ToolInputSchema,
  ToolInputSchemaDefinition,
} from "../../../schema/tool-input-schema";

function functionTool(
  name: string,
  inputSchema: ToolInputSchema
): LanguageModelV4FunctionTool {
  return { type: "function", name, inputSchema };
}

function sensitiveRecord(key: "constructor" | "prototype"): JSONObject {
  const record: JSONObject = {};
  Object.defineProperty(record, key, { enumerable: true, value: true });
  return record;
}

function schemaMatches(
  value: JSONValue | undefined,
  schema: ToolInputSchemaDefinition,
  enforceValueKinds = true
): boolean {
  return argumentValueMatchesSchemaKeyShape(
    value,
    schema,
    new Set(),
    enforceValueKinds
  );
}

describe("Hermes argument schema coverage", () => {
  it.each<readonly [ToolInputSchema["type"], JSONValue]>([
    ["array", []],
    ["boolean", true],
    ["integer", 1],
    ["null", null],
    ["number", 1.5],
    ["object", {}],
    ["string", "value"],
  ])("accepts a matching %s value kind", (type, value) => {
    // Given
    const schema = { type } satisfies ToolInputSchema;

    // When
    const matches = schemaMatches(value, schema);

    // Then
    expect(matches).toBe(true);
  });

  it.each<readonly [ToolInputSchema["type"], JSONValue | undefined]>([
    ["array", {}],
    ["boolean", "true"],
    ["integer", 1.5],
    ["null", undefined],
    ["number", Number.POSITIVE_INFINITY],
    ["object", []],
    ["string", 1],
  ])("rejects a nonmatching %s value kind", (type, value) => {
    // Given
    const schema = { type } satisfies ToolInputSchema;

    // When
    const matches = schemaMatches(value, schema);

    // Then
    expect(matches).toBe(false);
  });

  it("matches const and enum values structurally", () => {
    // Given
    const constSchema = {
      const: { first: [1], second: true },
    } satisfies ToolInputSchema;
    const enumSchema = {
      enum: ["first", { kind: "second" }],
    } satisfies ToolInputSchema;

    // When
    const constMatch = schemaMatches({ second: true, first: [1] }, constSchema);
    const enumMatch = schemaMatches({ kind: "second" }, enumSchema);

    // Then
    expect(constMatch).toBe(true);
    expect(enumMatch).toBe(true);
  });

  it.each<{ expected: JSONSchema7Type; value: JSONValue }>([
    { expected: [1], value: [1, 2] },
    { expected: [1], value: { 0: 1 } },
    { expected: { 0: 1 }, value: [1] },
    { expected: { first: 1 }, value: { second: 1 } },
    { expected: { first: 1 }, value: { first: 2 } },
    { expected: { first: null }, value: { first: {} } },
  ])("rejects unequal const structures", ({ expected, value }) => {
    // Given
    const schema = { const: expected } satisfies ToolInputSchema;

    // When
    const matches = schemaMatches(value, schema);

    // Then
    expect(matches).toBe(false);
  });

  it("reuses structural comparisons and pattern compilation safely", () => {
    // Given
    const sharedExpected = { label: "same" };
    const sharedValue = { label: "same" };
    const literalSchema = {
      const: { first: sharedExpected, second: sharedExpected },
    } satisfies ToolInputSchema;
    const patternProperties = {
      "^x-": { type: "string" },
      "^(a+)+$": {},
    } satisfies NonNullable<ToolInputSchema["patternProperties"]>;
    const patternSchema = {
      type: "object",
      patternProperties,
      additionalProperties: true,
    } satisfies ToolInputSchema;

    // When
    const literalMatches = schemaMatches(
      { first: sharedValue, second: sharedValue },
      literalSchema
    );
    const firstPatternMatch = schemaMatches(
      { "x-label": "ok", aaaa: true },
      patternSchema
    );
    const cachedPatternMatch = schemaMatches(
      { "x-other": "ok" },
      patternSchema
    );

    // Then
    expect(literalMatches).toBe(true);
    expect(firstPatternMatch).toBe(true);
    expect(cachedPatternMatch).toBe(true);
  });

  it("enforces object properties required keys and additional properties", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        value: { type: "string" },
        denied: false,
      },
      required: ["value"],
      additionalProperties: { type: "number" },
    } satisfies ToolInputSchema;

    // When
    const accepted = schemaMatches({ value: "ok", count: 1 }, schema);
    const missing = schemaMatches({}, schema);
    const denied = schemaMatches({ value: "ok", denied: true }, schema);
    const invalidAdditional = schemaMatches(
      { value: "ok", count: "one" },
      schema
    );

    const unknownDenied = schemaMatches(
      { unknown: true },
      { type: "object", additionalProperties: false }
    );

    // Then
    expect(accepted).toBe(true);
    expect(missing).toBe(false);
    expect(denied).toBe(false);
    expect(invalidAdditional).toBe(false);
    expect(unknownDenied).toBe(false);
  });

  it("enforces safe and unsafe pattern property schemas", () => {
    // Given
    const falsePattern = {
      type: "object",
      patternProperties: { "^blocked$": false },
      additionalProperties: true,
    } satisfies ToolInputSchema;
    const unsafePattern = {
      type: "object",
      patternProperties: { "^(a+)+$": { type: "string" } },
      additionalProperties: true,
    } satisfies ToolInputSchema;

    // When
    const denied = schemaMatches({ blocked: true }, falsePattern);
    const unsafeDenied = schemaMatches({ aaaa: "value" }, unsafePattern);

    // Then
    expect(denied).toBe(false);
    expect(unsafeDenied).toBe(false);
  });

  it("enforces tuple homogeneous and additional array items", () => {
    // Given
    const prefixSchema = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } satisfies ToolInputSchema;
    const tupleSchema = {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: false,
    } satisfies ToolInputSchema;
    const deniedSchema = {
      type: "array",
      items: false,
    } satisfies ToolInputSchema;

    // When
    const prefixAccepted = schemaMatches(["first", 2], prefixSchema);
    const tupleDenied = schemaMatches(["first", 2], tupleSchema);
    const itemDenied = schemaMatches([1], deniedSchema);

    const unconstrainedItems = schemaMatches([1], { type: "array" });
    const structuralMismatch = argumentValueMatchesSchemaKeyShape(
      "not-an-array",
      { items: { type: "string" } },
      new Set(),
      false
    );

    // Then
    expect(prefixAccepted).toBe(true);
    expect(tupleDenied).toBe(false);
    expect(itemDenied).toBe(false);
    expect(unconstrainedItems).toBe(true);
    expect(structuralMismatch).toBe(false);
  });

  it("combines allOf anyOf and oneOf including empty identities", () => {
    // Given
    const schema: ToolInputSchema = {};
    schema.allOf = [{ type: "object" }, { required: ["kind"] }];
    schema.anyOf = [{ properties: { kind: { const: "first" } } }, false];
    schema.oneOf = [
      { properties: { kind: { type: "string" } } },
      { properties: { count: { type: "number" } }, required: ["count"] },
    ];

    // When
    const accepted = schemaMatches({ kind: "first" }, schema);
    const duplicateOneOf = schemaMatches({ kind: "first", count: 1 }, schema);
    const emptyAll = schemaMatches("value", { allOf: [] });
    const emptyAny = schemaMatches("value", { anyOf: [] });
    const emptyOne = schemaMatches("value", { oneOf: [] });

    // Then
    expect(accepted).toBe(true);
    expect(duplicateOneOf).toBe(false);
    expect(emptyAll).toBe(true);
    expect(emptyAny).toBe(false);
    expect(emptyOne).toBe(false);
  });

  it("accepts explicit null and fails closed at the depth boundary", () => {
    // Given
    const nullable = {
      type: ["object", "null"],
      properties: { value: { type: "string" } },
    } satisfies ToolInputSchema;

    // When
    const nullMatches = schemaMatches(null, nullable);
    const booleanSchema = schemaMatches("anything", true);
    const falseSchema = schemaMatches("anything", false);
    const tooDeep = argumentValueMatchesSchemaKeyShape(
      {},
      true,
      new Set(),
      true,
      257
    );

    // Then
    expect(nullMatches).toBe(true);
    expect(booleanSchema).toBe(true);
    expect(falseSchema).toBe(false);
    expect(tooDeep).toBe(false);
  });

  it("rejects cyclic values and accepts already-seen containers", () => {
    // Given
    const cyclic: JSONObject = {};
    cyclic.self = cyclic;
    const value: JSONObject = { nested: true };

    // When
    const cycleMatches = argumentValueMatchesSchemaKeyShape(cyclic, true);
    const seenMatches = argumentValueMatchesSchemaKeyShape(
      value,
      { type: "object", additionalProperties: true },
      new Set([value]),
      true
    );

    // Then
    expect(cycleMatches).toBe(false);
    expect(seenMatches).toBe(true);
  });

  it("covers unconstrained and shape-only schema boundaries", () => {
    // Given
    const objectSchema = {
      properties: {},
      required: [""],
    } satisfies ToolInputSchema;
    const arraySchema = { items: {} } satisfies ToolInputSchema;

    // When
    const unconstrained = argumentValueMatchesSchemaKeyShape(undefined, true);
    const objectMismatch = argumentValueMatchesSchemaKeyShape(
      "value",
      objectSchema
    );
    const arrayMismatch = argumentValueMatchesSchemaKeyShape(
      "value",
      arraySchema
    );
    const extraDenied = argumentValueMatchesSchemaKeyShape(
      { extra: true },
      { type: "object", additionalProperties: false }
    );
    const untypedItems = argumentValueMatchesSchemaKeyShape([1], {
      type: "array",
    });
    const inferredArray = schemaMatches([1], { items: {} });

    // Then
    expect([unconstrained, objectMismatch, arrayMismatch]).toEqual([
      true,
      false,
      false,
    ]);
    expect(extraDenied).toBe(false);
    expect(untypedItems).toBe(true);
    expect(inferredArray).toBe(true);
  });
});

describe("Hermes argument key policy coverage", () => {
  it("extracts false missing wrapped and recursive schema policies", () => {
    // Given
    const recursive: ToolInputSchema = {
      properties: { direct: true, denied: false },
      required: ["required", ""],
      allOf: [],
    };
    recursive.allOf = [
      recursive,
      { properties: { nested: true } },
      { jsonSchema: false },
    ];
    const tools = [
      functionTool("deny", { jsonSchema: false }),
      functionTool("wrapped", { jsonSchema: { type: "object" } }),
      functionTool("recursive", recursive),
    ];

    // When
    const missing = extractArgumentKeyPolicy(tools, "missing");
    const denied = extractArgumentKeyPolicy(tools, "deny");
    const wrapped = extractArgumentKeyPolicy(tools, "wrapped");
    const recursivePolicy = extractArgumentKeyPolicy(tools, "recursive");

    // Then
    expect(missing).toBeUndefined();
    expect(denied).toEqual({
      knownKeys: new Set(),
      rejectAll: true,
      rejectNonRecordArguments: true,
      schema: false,
      unsafeConstrainedPatterns: [],
    });
    expect(wrapped?.rejectNonRecordArguments).toBe(true);
    expect(recursivePolicy?.knownKeys).toEqual(
      new Set(["direct", "required", "nested"])
    );
  });

  it("derives non-record rejection across schema combinators", () => {
    // Given
    const tools = [
      functionTool("all", { allOf: [true, { type: "object" }] }),
      functionTool("any", {
        anyOf: [{ properties: {} }, { required: ["value"] }],
      }),
      functionTool("one", {
        oneOf: [{ patternProperties: {} }, { additionalProperties: true }],
      }),
      functionTool("mixed", { anyOf: [{ type: "object" }, true] }),
      functionTool("empty", { oneOf: [] }),
      functionTool("combinator", { anyOf: [{ type: "object" }] }),
    ];

    // When
    const results = tools.map(
      (tool) =>
        extractArgumentKeyPolicy(tools, tool.name)?.rejectNonRecordArguments
    );

    // Then
    expect(results).toEqual([true, true, true, false, false, true]);
  });

  it("terminates rejection analysis for false and recursive branches", () => {
    // Given
    const recursive: ToolInputSchema = { allOf: [] };
    recursive.allOf = [recursive];
    const tools = [
      functionTool("false-branch", { allOf: [false] }),
      functionTool("recursive", recursive),
    ];

    // When
    const falseBranch = extractArgumentKeyPolicy(tools, "false-branch");
    const recursiveBranch = extractArgumentKeyPolicy(tools, "recursive");

    // Then
    expect(falseBranch?.rejectNonRecordArguments).toBe(true);
    expect(recursiveBranch?.rejectNonRecordArguments).toBe(false);
  });

  it("records constrained unsafe patterns but not false or unconstrained ones", () => {
    // Given
    const schema = {
      type: "object",
      patternProperties: {
        "^(a+)+$": { type: "string" },
        "^(b+)+$": false,
        "^(c+)+$": {},
        "^safe-": { type: "number" },
      },
    } satisfies ToolInputSchema;

    // When
    const policy = extractArgumentKeyPolicy(
      [functionTool("tool", schema)],
      "tool"
    );

    // Then
    expect(policy?.unsafeConstrainedPatterns).toEqual(["^(a+)+$"]);
  });

  it("applies absent reject-all cycle prototype and unsafe policies", () => {
    // Given
    const safe: JSONObject = { value: "ok" };
    const cyclic: JSONObject = {};
    cyclic.self = cyclic;
    const prototypeSensitive = sensitiveRecord("constructor");
    const deny = extractArgumentKeyPolicy(
      [functionTool("deny", { jsonSchema: false })],
      "deny"
    );
    const unsafe = extractArgumentKeyPolicy(
      [
        functionTool("unsafe", {
          type: "object",
          patternProperties: { "^(a+)+$": { type: "string" } },
          additionalProperties: true,
        }),
      ],
      "unsafe"
    );

    // When
    const unchanged = applyArgumentKeyPolicy(safe);
    const cyclicResult = applyArgumentKeyPolicy(cyclic);
    const prototypeResult = applyArgumentKeyPolicy(prototypeSensitive);
    const denied = applyArgumentKeyPolicy(safe, deny);
    const unsafeDenied = applyArgumentKeyPolicy({ aaaa: "ok" }, unsafe);

    // Then
    expect(unchanged).toBe(safe);
    expect(cyclicResult).toBeNull();
    expect(prototypeResult).toBeNull();
    expect(denied).toBeNull();
    expect(unsafeDenied).toBeNull();
  });

  it("rejects a prototype-sensitive key introduced by strict coercion", () => {
    // Given
    const constructorSchema = { type: "array" } satisfies ToolInputSchema;
    const schema = {
      type: "object",
      properties: { constructor: constructorSchema },
      required: ["constructor"],
      additionalProperties: false,
    } satisfies ToolInputSchema;
    const policy = extractArgumentKeyPolicy(
      [functionTool("rename", schema)],
      "rename"
    );

    // When
    const result = applyArgumentKeyPolicy({ constructors: [1] }, policy);

    // Then
    expect(result).toBeNull();
  });

  it("checks an unsafe key introduced by strict plural coercion", () => {
    // Given
    const policy = extractArgumentKeyPolicy(
      [
        functionTool("unsafe-rename", {
          type: "object",
          properties: { aaaa: { type: "array" } },
          required: ["aaaa"],
          patternProperties: { "^(a+)+$": { type: "array" } },
          additionalProperties: false,
        }),
      ],
      "unsafe-rename"
    );

    // When
    const result = applyArgumentKeyPolicy({ aaaas: [1] }, policy);

    // Then
    expect(result).toBeNull();
  });

  it("coerces sanitizes and validates object arguments", () => {
    // Given
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
        payload: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      required: ["count", "payload"],
      additionalProperties: false,
    } satisfies ToolInputSchema;
    const policy = extractArgumentKeyPolicy(
      [functionTool("tool", schema)],
      "tool"
    );

    // When
    const applied = applyArgumentKeyPolicy(
      { count: "2", payload: { value: "ok", secret: "drop" }, extra: true },
      policy
    );
    const missing = applyArgumentKeyPolicy({ count: "2" }, policy);

    // Then
    expect(applied).toEqual({ count: 2, payload: { value: "ok" } });
    expect(missing).toBeNull();
  });

  it("handles primitive coercion and validation-free object schemas", () => {
    // Given
    const primitivePolicy = extractArgumentKeyPolicy(
      [functionTool("number", { type: "number" })],
      "number"
    );
    const emptyPolicy = extractArgumentKeyPolicy(
      [functionTool("empty", {})],
      "empty"
    );
    const combinatorPolicy = extractArgumentKeyPolicy(
      [functionTool("combinator", { allOf: [] })],
      "combinator"
    );
    const truePolicy = {
      knownKeys: new Set<string>(),
      rejectAll: false,
      rejectNonRecordArguments: false,
      schema: true,
      unsafeConstrainedPatterns: [],
    } satisfies import("../../../core/protocols/hermes-argument-key-policy").ArgumentKeyPolicy;

    // When
    const primitive = applyArgumentKeyPolicy({ value: "2" }, primitivePolicy);
    const empty = applyArgumentKeyPolicy({}, emptyPolicy);
    const unconstrained = applyArgumentKeyPolicy({}, truePolicy);
    const combinator = applyArgumentKeyPolicy({}, combinatorPolicy);

    // Then
    expect(primitive).toBeNull();
    expect(empty).toEqual({});
    expect(unconstrained).toEqual({});
    expect(combinator).toEqual({});
  });

  it("rejects conflicting oneOf keys unless one literal discriminator matches", () => {
    // Given
    const schema: ToolInputSchema = {
      type: "object",
      oneOf: [
        {
          properties: {
            kind: { const: "first" },
            first: { type: "string" },
            metadata: true,
          },
        },
        {
          properties: {
            kind: { enum: ["second"] },
            second: { type: "string" },
          },
        },
      ],
      additionalProperties: true,
    };
    const policy = extractArgumentKeyPolicy(
      [functionTool("tool", schema)],
      "tool"
    );

    // When
    const conflict = applyArgumentKeyPolicy(
      { first: "a", second: "b" },
      policy
    );
    const discriminated = applyArgumentKeyPolicy(
      { kind: "first", first: "a", second: "b", metadata: true },
      policy
    );
    const wrongDiscriminator = applyArgumentKeyPolicy(
      { kind: "other", first: "a", second: "b" },
      policy
    );
    const nonObjectConflict = applyArgumentKeyPolicy(
      { first: "a", second: "b" },
      extractArgumentKeyPolicy(
        [
          functionTool("mixed", {
            oneOf: [
              true,
              {
                properties: { first: {} },
                patternProperties: { "^first$": {} },
              },
              { properties: { second: {} } },
            ],
          }),
        ],
        "mixed"
      )
    );

    // Then
    expect(conflict).toBeNull();
    expect(discriminated).toEqual({
      kind: "first",
      first: "a",
      second: "b",
      metadata: true,
    });
    expect(wrongDiscriminator).toBeNull();
    expect(nonObjectConflict).toBeNull();
  });

  it("allows unknown keys when patterns are advisory and additional properties are true", () => {
    // Given
    const schema = {
      type: "object",
      patternProperties: { "^x-": { type: "number" } },
      additionalProperties: true,
    } satisfies ToolInputSchema;
    const policy = extractArgumentKeyPolicy(
      [functionTool("tool", schema)],
      "tool"
    );

    // When
    const applied = applyArgumentKeyPolicy(
      { "x-count": "2", ordinary: "kept" },
      policy
    );

    // Then
    expect(applied).toEqual({ "x-count": 2, ordinary: "kept" });
  });

  it("identifies policy errors", () => {
    // Given
    const policyError = new ArgumentKeyPolicyError("invalid arguments");
    const ordinaryError = new Error("ordinary");

    // When
    const policyResult = isArgumentKeyPolicyError(policyError);
    const ordinaryResult = isArgumentKeyPolicyError(ordinaryError);

    // Then
    expect(policyError.name).toBe("ArgumentKeyPolicyError");
    expect(policyResult).toBe(true);
    expect(ordinaryResult).toBe(false);
  });

  it("finds prototype-sensitive keys in nested JSON values", () => {
    // Given
    const repeated: JSONObject = { value: true };
    const safe: JSONValue = [repeated, repeated, null, "value"];
    const unsafe: JSONValue = [{ nested: sensitiveRecord("prototype") }];

    // When
    const safeResult = containsPrototypeSensitiveArgumentKey(safe);
    const unsafeResult = containsPrototypeSensitiveArgumentKey(unsafe);

    // Then
    expect(safeResult).toBe(false);
    expect(unsafeResult).toBe(true);
  });

  it("terminates on repeated safe arrays", () => {
    // Given
    const shared: JSONValue[] = [{ safe: true }];
    const value: JSONValue = [shared, shared];

    // When
    const result = containsPrototypeSensitiveArgumentKey(value);

    // Then
    expect(result).toBe(false);
  });

  it.each([
    ["no object", false],
    ['prefix {"safe":1}', false],
    ['/* comment */ {"constructor":1}', true],
    ['// comment\n {"prototype":1}', true],
    ['[{"__proto__":1}]', true],
    ['{"nested":{"safe":1}}', false],
    ["{ malformed", false],
    ["{", false],
  ])("scans JSON-like object keys in %s", (text, expected) => {
    // Given
    const input = text;

    // When
    const sensitive = hasPrototypeSensitiveKeyInJsonLikeObject(input);

    // Then
    expect(sensitive).toBe(expected);
  });
});
