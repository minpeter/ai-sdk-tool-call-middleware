import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  coerceBySchema,
  compileSafePatternPropertyRegex,
  getSchemaType,
  schemaIsUnconstrained,
  unwrapJsonSchema,
} from "../../schema-coerce";
import { toolCallInputHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
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

export interface ArgumentKeyPolicy {
  knownKeys: Set<string>;
  rejectAll: boolean;
  rejectNonRecordArguments: boolean;
  schema: unknown;
  unsafeConstrainedPatterns: string[];
}

export class ArgumentKeyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentKeyPolicyError";
  }
}

export function isArgumentKeyPolicyError(error: unknown): boolean {
  return error instanceof ArgumentKeyPolicyError;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function addDirectArgumentKnownKeys(
  keys: Set<string>,
  schema: Record<string, unknown>
): void {
  if (isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        keys.add(key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && key.length > 0) {
        keys.add(key);
      }
    }
  }
}

function addCombinatorArgumentKnownKeys(
  keys: Set<string>,
  schema: Record<string, unknown>,
  seen: Set<object>
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
  schema: unknown,
  seen = new Set<object>()
): Set<string> {
  const unwrapped = unwrapJsonSchema(schema);
  const keys = new Set<string>();
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return keys;
  }
  seen.add(unwrapped);
  addDirectArgumentKnownKeys(keys, unwrapped);
  addCombinatorArgumentKnownKeys(keys, unwrapped, seen);
  return keys;
}

function schemaRejectsNonRecordArguments(
  schema: unknown,
  seen = new Set<object>()
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (unwrapped === false) {
    return true;
  }
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);
  if (
    getSchemaType(unwrapped) === "object" ||
    isRecord(unwrapped.properties) ||
    isRecord(unwrapped.patternProperties) ||
    Array.isArray(unwrapped.required) ||
    Object.hasOwn(unwrapped, "additionalProperties")
  ) {
    return true;
  }

  const allOf = Array.isArray(unwrapped.allOf) ? unwrapped.allOf : undefined;
  if (
    allOf?.some((subSchema) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const anyOf = Array.isArray(unwrapped.anyOf) ? unwrapped.anyOf : undefined;
  if (
    anyOf &&
    anyOf.length > 0 &&
    anyOf.every((subSchema) =>
      schemaRejectsNonRecordArguments(subSchema, new Set(seen))
    )
  ) {
    return true;
  }

  const oneOf = Array.isArray(unwrapped.oneOf) ? unwrapped.oneOf : undefined;
  return (
    oneOf !== undefined &&
    oneOf.length > 0 &&
    oneOf.every((subSchema) =>
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
  if (!isRecord(schema)) {
    return;
  }
  const unsafeConstrainedPatterns: string[] = [];
  if (isRecord(schema.patternProperties)) {
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
  args: Record<string, unknown>,
  keyPolicy?: ArgumentKeyPolicy
): Record<string, unknown> | null {
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
  if (!isRecord(coercedPolicyArgs)) {
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
  if (!isRecord(policyArgs)) {
    return null;
  }
  if (toolCallInputHasPrototypeSensitiveKey(policyArgs)) {
    return null;
  }
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
  args: Record<string, unknown>,
  keyPolicy?: ArgumentKeyPolicy
): unknown {
  return keyPolicy ? coerceBySchema(args, keyPolicy.schema) : args;
}

function sanitizeArgsByArgumentKeyPolicy(
  args: Record<string, unknown>,
  keyPolicy: ArgumentKeyPolicy
): Record<string, unknown> {
  const sanitized = sanitizeToolCallArgsBySchema(args, keyPolicy.schema);
  return isRecord(sanitized) ? sanitized : args;
}

function topLevelOneOfHasConflictingDeclaredKeys(
  args: Record<string, unknown>,
  schema: unknown
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (!(isRecord(unwrapped) && Array.isArray(unwrapped.oneOf))) {
    return false;
  }

  if (oneOfHasSingleLiteralDiscriminatorMatch(args, unwrapped.oneOf)) {
    return false;
  }

  const branchNames = unwrapped.oneOf.map((variant) => {
    const names = collectSchemaSelectionPropertyNames(variant);
    const branchSchema = unwrapJsonSchema(variant);
    if (isRecord(branchSchema)) {
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
  args: Record<string, unknown>,
  variants: unknown[]
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
  variant: unknown,
  args: Record<string, unknown>
): boolean {
  const unwrapped = unwrapJsonSchema(variant);
  if (!(isRecord(unwrapped) && isRecord(unwrapped.properties))) {
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
  schema: unknown,
  value: unknown
): boolean | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return;
  }
  if (Object.hasOwn(unwrapped, "const")) {
    return JSON.stringify(unwrapped.const) === JSON.stringify(value);
  }
  if (Array.isArray(unwrapped.enum)) {
    return unwrapped.enum.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(value)
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
  if (!isRecord(schema)) {
    return true;
  }
  return (
    isRecord(schema.patternProperties) ||
    schemaHasTopLevelCombinator(schema, new Set())
  );
}

function schemaWithoutPatternProperties(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "patternProperties") {
      out[key] = value;
    }
  }
  return out;
}

function schemaForArgumentSchemaKeyShapeValidation(
  keyPolicy: ArgumentKeyPolicy
): unknown {
  const schema = unwrapJsonSchema(keyPolicy.schema);
  if (
    isRecord(schema) &&
    schema.additionalProperties === true &&
    isRecord(schema.patternProperties)
  ) {
    return schemaWithoutPatternProperties(schema);
  }
  return keyPolicy.schema;
}

function keysMatchUnsafeConstrainedPattern(
  args: Record<string, unknown>,
  keyPolicy: ArgumentKeyPolicy
): boolean {
  return Object.keys(args).some((key) =>
    keyPolicy.unsafeConstrainedPatterns.some((pattern) =>
      unsafeDeniedPatternMayMatchKey(pattern, key)
    )
  );
}

function schemaHasTopLevelCombinator(
  schema: unknown,
  seen: Set<object>
): boolean {
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped) || seen.has(unwrapped)) {
    return false;
  }
  seen.add(unwrapped);
  return (
    Array.isArray(unwrapped.allOf) ||
    Array.isArray(unwrapped.anyOf) ||
    Array.isArray(unwrapped.oneOf)
  );
}

const PROTOTYPE_SENSITIVE_ARGUMENT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function containsPrototypeSensitiveArgumentKey(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [value];

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
    if (!isRecord(current)) {
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
