import type { RxmlValue } from "../../rxml/builders/stringify";
import {
  isSchemaDefinition,
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import { isPrototypeSensitiveArgumentKey } from "./prototype-sensitive-keys";
import { getDeclaredPropertySchema } from "./tool-call-object-property-schema";
import {
  collectPatternPropertyNames,
  hasDeclaredPatternProperties,
  unsafeFalsePatternMayMatchKey,
} from "./tool-call-pattern-properties";
import {
  collectAllOfDeniedPropertyNames,
  collectFalsePropertyNames,
} from "./tool-call-property-deny";
import { selectSchemaVariant } from "./tool-call-schema-variant";

const SELECTIVE_JSON_SCHEMA_COMBINATORS = ["anyOf", "oneOf"] as const;

function isToolInputSchema(
  schema: ToolInputSchemaDefinition | undefined
): schema is ToolInputSchema {
  return typeof schema === "object" && isSchemaRecord(schema);
}

function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapToolCallSchema(
  schema: ToolInputSchemaDefinition
): ToolInputSchemaDefinition | undefined {
  return unwrapJsonSchema(schema);
}

function addSafePropertyName(names: Set<string>, key: RxmlValue): void {
  if (typeof key === "string" && !isPrototypeSensitiveArgumentKey(key)) {
    names.add(key);
  }
}

function collectDirectDeclaredPropertyNames(
  schema: ToolInputSchema
): Set<string> {
  const names = new Set<string>();
  const falsePropertyNames = collectFalsePropertyNames(schema);
  if (Object.hasOwn(schema, "properties") && schema.properties) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (propertySchema !== false) {
        addSafePropertyName(names, key);
      }
    }
  }
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(typeof key === "string" && falsePropertyNames.has(key))) {
        addSafePropertyName(names, key);
      }
    }
  }
  return names;
}

function addNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.add(name);
  }
}

function removeNames(target: Set<string>, source: Set<string>): void {
  for (const name of source) {
    target.delete(name);
  }
}

function hasStrictAdditionalProperties(
  schema: ToolInputSchemaDefinition
): boolean {
  const unwrapped = unwrapToolCallSchema(schema);
  return (
    isToolInputSchema(unwrapped) && unwrapped.additionalProperties === false
  );
}

function collectAllOfDeclaredPropertyNames(
  schema: ToolInputSchema,
  value: RxmlValue,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  if (!Array.isArray(schema.allOf)) {
    return null;
  }
  for (const variant of schema.allOf) {
    const nestedNames = collectDeclaredToolInputPropertyNames(
      variant,
      value,
      new Set(seen)
    );
    if (nestedNames) {
      addNames(names, nestedNames);
      found = true;
    }
  }
  return found ? names : null;
}

function collectStrictAllOfDeniedPropertyNames(
  schema: ToolInputSchema,
  value: RxmlValue,
  seen: Set<object>
): Set<string> {
  const names = new Set<string>();
  if (!(Array.isArray(schema.allOf) && isRxmlRecord(value))) {
    return names;
  }
  for (const variant of schema.allOf) {
    const unwrapped = unwrapToolCallSchema(variant);
    if (!isToolInputSchema(unwrapped) || seen.has(unwrapped)) {
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(unwrapped);
    if (hasStrictAdditionalProperties(unwrapped)) {
      const allowedNames =
        collectDeclaredToolInputPropertyNames(variant, value, new Set(seen)) ??
        new Set();
      for (const key of Object.keys(value)) {
        if (!allowedNames.has(key)) {
          names.add(key);
        }
      }
    }
    addNames(
      names,
      collectStrictAllOfDeniedPropertyNames(unwrapped, value, nextSeen)
    );
  }
  return names;
}

function collectSelectedVariantDeclaredPropertyNames(
  schema: ToolInputSchema,
  value: RxmlValue,
  seen: Set<object>
): Set<string> | null {
  const names = new Set<string>();
  let found = false;
  for (const combinator of SELECTIVE_JSON_SCHEMA_COMBINATORS) {
    const variant = selectSchemaVariant(schema[combinator], value, seen);
    if (!isSchemaDefinition(variant)) {
      continue;
    }
    const nestedNames = collectDeclaredToolInputPropertyNames(
      variant,
      value,
      new Set(seen)
    );
    if (nestedNames) {
      found = true;
      addNames(names, nestedNames);
    }
  }
  return found ? names : null;
}

function collectDeclaredToolInputPropertyNames(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue,
  seen: Set<object>
): Set<string> | null {
  const unwrapped = unwrapToolCallSchema(schema);
  if (!isToolInputSchema(unwrapped) || seen.has(unwrapped)) {
    return null;
  }
  seen.add(unwrapped);

  const names = collectDirectDeclaredPropertyNames(unwrapped);
  const hasDirectProperties =
    Object.hasOwn(unwrapped, "properties") &&
    unwrapped.properties !== undefined;
  const hasAdditionalPropertiesPolicy = Object.hasOwn(
    unwrapped,
    "additionalProperties"
  );
  const declaredPatternProperties = hasDeclaredPatternProperties(unwrapped);
  const allOfNames = collectAllOfDeclaredPropertyNames(unwrapped, value, seen);
  const selectedVariantNames = collectSelectedVariantDeclaredPropertyNames(
    unwrapped,
    value,
    seen
  );
  if (allOfNames) {
    addNames(names, allOfNames);
  }
  if (selectedVariantNames) {
    addNames(names, selectedVariantNames);
  }
  const hasPropertySelectionPolicy = [
    hasDirectProperties,
    hasAdditionalPropertiesPolicy,
    declaredPatternProperties,
    allOfNames,
    selectedVariantNames,
  ].some(Boolean);
  if (hasPropertySelectionPolicy) {
    addNames(names, collectPatternPropertyNames(unwrapped, value));
  }
  if (
    (unwrapped.additionalProperties === true ||
      isToolInputSchema(unwrapped.additionalProperties)) &&
    isRxmlRecord(value)
  ) {
    for (const key of Object.keys(value)) {
      if (!unsafeFalsePatternMayMatchKey(unwrapped, key)) {
        addSafePropertyName(names, key);
      }
    }
  }
  removeNames(names, collectAllOfDeniedPropertyNames(unwrapped, new Set(seen)));
  removeNames(
    names,
    collectStrictAllOfDeniedPropertyNames(unwrapped, value, new Set(seen))
  );

  if (names.size === 0 && !hasPropertySelectionPolicy) {
    return null;
  }
  return names;
}

export function getToolInputPropertyNames(
  schema: ToolInputSchemaDefinition,
  value: RxmlValue
): Set<string> | null {
  return collectDeclaredToolInputPropertyNames(schema, value, new Set());
}

export function getToolInputPropertySchema(
  schema: ToolInputSchemaDefinition,
  key: string,
  value: RxmlValue
): ToolInputSchemaDefinition | undefined {
  return getDeclaredPropertySchema(schema, key, value, new Set());
}
