import type {
  JSONArray,
  JSONObject,
  JSONValue,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isCycleSafeJsonValue,
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaCandidate,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import {
  coerceBySchema,
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { toolCallInputHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { getToolInputPropertyNames } from "../utils/tool-call-object-schema";
import { collectPatternPropertyNames } from "../utils/tool-call-pattern-properties";
import { collectSchemaSelectionPropertyNames } from "../utils/tool-call-schema-property-names";
import { sanitizeToolCallArgsBySchema } from "../utils/tool-call-schema-sanitization";
import { unsafeDeniedPatternMayMatchKey } from "../utils/unsafe-pattern";
import { argumentValueMatchesSchemaKeyShape } from "./hermes-argument-schema";
import {
  collectObjectKeys,
  skipJsonComment,
  skipJsonWhitespace,
} from "./hermes-json-object-key-scanner";
import type { ResolvedProtocolToolCall } from "./protocol-interface";

export interface ArgumentKeyPolicy {
  readonly knownKeys: Set<string>;
  readonly rejectAll: boolean;
  readonly rejectNonRecordArguments: boolean;
  readonly schema: ToolInputSchemaDefinition;
  readonly unsafeConstrainedPatterns: readonly string[];
}

export class ArgumentKeyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentKeyPolicyError";
  }
}

export function isArgumentKeyPolicyError(
  error: Extract<ResolvedProtocolToolCall, { ok: false }>["error"]
): boolean {
  return error instanceof ArgumentKeyPolicyError;
}

function isJsonObject(value: RxmlValue): value is JSONObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isSchemaObject(
  value: ToolInputSchemaCandidate
): value is ToolInputSchema {
  return isSchemaRecord(value);
}

function isSchemaMap(
  value: ToolInputSchemaCandidate
): value is Record<string, ToolInputSchemaDefinition> {
  return isSchemaRecord(value);
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function addDirectArgumentKnownKeys(
  keys: Set<string>,
  schema: ToolInputSchema
): void {
  if (isSchemaMap(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        keys.add(key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (key.length > 0) {
        keys.add(key);
      }
    }
  }
}

function addCombinatorArgumentKnownKeys(
  keys: Set<string>,
  schema: ToolInputSchema,
  seen: Set<ToolInputSchema>
): void {
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[combinator];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      for (const key of collectArgumentKnownKeys(variant, new Set(seen))) {
        keys.add(key);
      }
    }
  }
}

function collectArgumentKnownKeys(
  schema: ToolInputSchemaDefinition | undefined,
  seen = new Set<ToolInputSchema>()
): Set<string> {
  const unwrapped = unwrapJsonSchema(schema);
  const keys = new Set<string>();
  if (!isSchemaObject(unwrapped) || seen.has(unwrapped)) {
    return keys;
  }
  seen.add(unwrapped);
  addDirectArgumentKnownKeys(keys, unwrapped);
  addCombinatorArgumentKnownKeys(keys, unwrapped, seen);
  return keys;
}

function schemaRejectsNonRecordArguments(
  schema: ToolInputSchemaDefinition | undefined,
  seen = new Set<ToolInputSchema>()
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return true;
  }
  if (!isSchemaObject(unwrapped)) {
    return false;
  }
  if (seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);
  if (
    getSchemaType(unwrapped) === "object" ||
    isSchemaMap(unwrapped.properties) ||
    isSchemaMap(unwrapped.patternProperties) ||
    Array.isArray(unwrapped.required) ||
    Object.hasOwn(unwrapped, "additionalProperties")
  ) {
    return true;
  }

  const allOf = Array.isArray(unwrapped.allOf) ? unwrapped.allOf : undefined;
  if (
    allOf?.some((subSchema: ToolInputSchemaDefinition) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const anyOf = Array.isArray(unwrapped.anyOf) ? unwrapped.anyOf : undefined;
  if (
    anyOf &&
    anyOf.length > 0 &&
    anyOf.every((subSchema: ToolInputSchemaDefinition) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const oneOf = Array.isArray(unwrapped.oneOf) ? unwrapped.oneOf : undefined;
  return (
    oneOf !== undefined &&
    oneOf.length > 0 &&
    oneOf.every((subSchema: ToolInputSchemaDefinition) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  );
}

export function extractArgumentKeyPolicy(
  tools: LanguageModelV4FunctionTool[],
  toolName: string
): ArgumentKeyPolicy | undefined {
  const tool = tools.find((t) => t.name === toolName);
  const schema = unwrapJsonSchema(tool?.inputSchema);
  if (schema === false) {
    return {
      knownKeys: new Set(),
      rejectAll: true,
      rejectNonRecordArguments: true,
      schema,
      unsafeConstrainedPatterns: [],
    };
  }
  if (!isSchemaObject(schema)) {
    return;
  }
  const unsafeConstrainedPatterns: string[] = [];
  if (isSchemaMap(schema.patternProperties)) {
    for (const [pattern, patternSchema] of Object.entries(
      schema.patternProperties
    )) {
      if (
        patternSchema !== false &&
        compileSafePatternPropertyRegex(pattern) === null &&
        !schemaIsUnconstrained(patternSchema)
      ) {
        unsafeConstrainedPatterns.push(pattern);
      }
    }
  }
  return {
    knownKeys: collectArgumentKnownKeys(schema),
    rejectAll: false,
    rejectNonRecordArguments: schemaRejectsNonRecordArguments(schema),
    schema,
    unsafeConstrainedPatterns,
  };
}

export function applyArgumentKeyPolicy(
  args: JSONObject,
  keyPolicy?: ArgumentKeyPolicy
): JSONObject | null {
  if (!isCycleSafeJsonValue(args)) {
    return null;
  }
  if (keyPolicy?.rejectAll) {
    return null;
  }
  if (toolCallInputHasPrototypeSensitiveKey(args)) {
    return null;
  }
  if (keyPolicy && keysMatchUnsafeConstrainedPattern(args, keyPolicy)) {
    return null;
  }
  if (
    keyPolicy &&
    topLevelOneOfHasConflictingDeclaredKeys(args, keyPolicy.schema)
  ) {
    return null;
  }
  const coercedPolicyArgs = coerceArgsForKeyPolicy(args, keyPolicy);
  if (!isJsonObject(coercedPolicyArgs)) {
    return null;
  }
  if (toolCallInputHasPrototypeSensitiveKey(coercedPolicyArgs)) {
    return null;
  }
  if (
    keyPolicy &&
    keysMatchUnsafeConstrainedPattern(coercedPolicyArgs, keyPolicy)
  ) {
    return null;
  }
  const policyArgs = keyPolicy
    ? sanitizeArgsByArgumentKeyPolicy(coercedPolicyArgs, keyPolicy)
    : coercedPolicyArgs;
  if (
    keyPolicy &&
    shouldValidateArgumentSchemaKeyShape(keyPolicy) &&
    !argumentValueMatchesSchemaKeyShape(
      policyArgs,
      schemaForArgumentSchemaKeyShapeValidation(keyPolicy),
      new Set(),
      true
    )
  ) {
    return null;
  }
  return policyArgs;
}

function coerceArgsForKeyPolicy(
  args: JSONObject,
  keyPolicy?: ArgumentKeyPolicy
) {
  return keyPolicy ? coerceBySchema(args, keyPolicy.schema) : args;
}

function sanitizeArgsByArgumentKeyPolicy(
  args: JSONObject,
  keyPolicy: ArgumentKeyPolicy
): JSONObject {
  if (getToolInputPropertyNames(keyPolicy.schema, args) === null) {
    return args;
  }
  const sanitized: JSONObject = Object.create(null);
  return Object.assign(
    sanitized,
    sanitizeToolCallArgsBySchema(args, keyPolicy.schema)
  );
}

function topLevelOneOfHasConflictingDeclaredKeys(
  args: JSONObject,
  schema: ToolInputSchemaDefinition
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (!(isSchemaObject(unwrapped) && Array.isArray(unwrapped.oneOf))) {
    return false;
  }

  if (oneOfHasSingleLiteralDiscriminatorMatch(args, unwrapped.oneOf)) {
    return false;
  }

  const branchNames = unwrapped.oneOf.map((variant) => {
    const names = collectSchemaSelectionPropertyNames(variant);
    const branchSchema = unwrapJsonSchema(variant);
    if (isSchemaObject(branchSchema)) {
      addNames(names, collectPatternPropertyNames(branchSchema, args));
    }
    return names;
  });
  const keyBranchCounts = new Map<string, number>();
  for (const names of branchNames) {
    for (const name of names) {
      keyBranchCounts.set(name, (keyBranchCounts.get(name) ?? 0) + 1);
    }
  }

  let matchedBranches = 0;
  for (const names of branchNames) {
    for (const name of names) {
      if (keyBranchCounts.get(name) === 1 && Object.hasOwn(args, name)) {
        matchedBranches += 1;
        break;
      }
    }
  }
  return matchedBranches > 1;
}

function oneOfHasSingleLiteralDiscriminatorMatch(
  args: JSONObject,
  variants: NonNullable<ToolInputSchema["oneOf"]>
): boolean {
  let matches = 0;
  for (const variant of variants) {
    if (variantHasLiteralDiscriminatorMatch(variant, args)) {
      matches += 1;
    }
  }
  return matches === 1;
}

function variantHasLiteralDiscriminatorMatch(
  variant: ToolInputSchemaDefinition,
  args: JSONObject
): boolean {
  const unwrapped = unwrapJsonSchema(variant);
  if (!(isSchemaObject(unwrapped) && isSchemaMap(unwrapped.properties))) {
    return false;
  }
  let sawMatch = false;
  for (const [key, propertySchema] of Object.entries(unwrapped.properties)) {
    if (!Object.hasOwn(args, key)) {
      continue;
    }
    const literalMatch = propertySchemaLiteralMatch(propertySchema, args[key]);
    if (literalMatch === false) {
      return false;
    }
    if (literalMatch === true) {
      sawMatch = true;
    }
  }
  return sawMatch;
}

function propertySchemaLiteralMatch(
  schema: ToolInputSchemaDefinition,
  value: JSONValue | undefined
): boolean | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isSchemaObject(unwrapped)) {
    return;
  }
  if (Object.hasOwn(unwrapped, "const")) {
    return JSON.stringify(unwrapped.const) === JSON.stringify(value);
  }
  if (Array.isArray(unwrapped.enum)) {
    return unwrapped.enum.some(
      (entry: JSONValue) => JSON.stringify(entry) === JSON.stringify(value)
    );
  }
}

function shouldValidateArgumentSchemaKeyShape(
  keyPolicy: ArgumentKeyPolicy
): boolean {
  if (keyPolicy.knownKeys.size > 0) {
    return true;
  }
  const schema = unwrapJsonSchema(keyPolicy.schema);
  if (!isSchemaObject(schema)) {
    return true;
  }
  return (
    isSchemaMap(schema.patternProperties) || schemaHasTopLevelCombinator(schema)
  );
}

function schemaWithoutPatternProperties(
  schema: ToolInputSchema
): ToolInputSchema {
  const { patternProperties: _patternProperties, ...out } = schema;
  return out;
}

function schemaForArgumentSchemaKeyShapeValidation(
  keyPolicy: ArgumentKeyPolicy
): ToolInputSchemaDefinition {
  const schema = unwrapJsonSchema(keyPolicy.schema);
  if (
    isSchemaObject(schema) &&
    schema.additionalProperties === true &&
    isSchemaMap(schema.patternProperties)
  ) {
    return schemaWithoutPatternProperties(schema);
  }
  return keyPolicy.schema;
}

function keysMatchUnsafeConstrainedPattern(
  args: JSONObject,
  keyPolicy: ArgumentKeyPolicy
): boolean {
  return Object.keys(args).some((key) =>
    keyPolicy.unsafeConstrainedPatterns.some((pattern) =>
      unsafeDeniedPatternMayMatchKey(pattern, key)
    )
  );
}

function schemaHasTopLevelCombinator(
  schema: ToolInputSchemaDefinition
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  return (
    isSchemaObject(unwrapped) &&
    (Array.isArray(unwrapped.allOf) ||
      Array.isArray(unwrapped.anyOf) ||
      Array.isArray(unwrapped.oneOf))
  );
}

const PROTOTYPE_SENSITIVE_ARGUMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function containsPrototypeSensitiveArgumentKey(
  value: JSONValue
): boolean {
  const seen = new Set<JSONArray | JSONObject>();
  const stack: (JSONValue | undefined)[] = [value];

  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const item of current) {
        stack.push(item);
      }
      continue;
    }
    if (!isJsonObject(current)) {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const key of Object.keys(current)) {
      if (PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)) {
        return true;
      }
      stack.push(current[key]);
    }
  }

  return false;
}

export function hasPrototypeSensitiveKeyInJsonLikeObject(
  text: string
): boolean {
  let firstBrace = skipJsonWhitespace(text, 0);
  while (true) {
    const commentEnd = skipJsonComment(text, firstBrace);
    if (commentEnd === null) {
      break;
    }
    firstBrace = skipJsonWhitespace(text, commentEnd + 1);
  }
  if (text.charAt(firstBrace) !== "{") {
    firstBrace = text.indexOf("{", firstBrace);
  }
  if (firstBrace === -1) {
    return false;
  }
  return (collectObjectKeys(text, firstBrace, true) ?? []).some((key) =>
    PROTOTYPE_SENSITIVE_ARGUMENT_KEYS.has(key)
  );
}
