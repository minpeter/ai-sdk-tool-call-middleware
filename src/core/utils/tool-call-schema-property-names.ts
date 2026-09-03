import { unwrapJsonSchema } from "../../schema-coerce";
import type { SchemaBoundaryValue } from "./tool-call-object-schema";
import { collectFalsePropertyNames } from "./tool-call-property-deny";

type SchemaBoundaryRecord = Record<string, SchemaBoundaryValue>;

function isRecord<Value>(value: Value): value is Value & SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDeclaredProperties(
  names: Set<string>,
  properties: SchemaBoundaryValue
): void {
  if (!isRecord(properties)) {
    return;
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (propertySchema !== false) {
      names.add(key);
    }
  }
}

function addRequiredProperties(
  names: Set<string>,
  required: SchemaBoundaryValue,
  falsePropertyNames: Set<string>
): void {
  if (!Array.isArray(required)) {
    return;
  }
  for (const key of required) {
    if (typeof key === "string" && !falsePropertyNames.has(key)) {
      names.add(key);
    }
  }
}

function addAllOfPropertyNames(
  names: Set<string>,
  variants: SchemaBoundaryValue
): void {
  if (!Array.isArray(variants)) {
    return;
  }
  for (const variant of variants) {
    for (const name of collectSchemaSelectionPropertyNames(variant)) {
      names.add(name);
    }
  }
}

export function collectSchemaSelectionPropertyNames<Schema>(
  schema: Schema
): Set<string> {
  const names = new Set<string>();
  const unwrapped = unwrapJsonSchema(schema);
  if (!isRecord(unwrapped)) {
    return names;
  }
  addDeclaredProperties(names, unwrapped.properties);
  addRequiredProperties(
    names,
    unwrapped.required,
    collectFalsePropertyNames(unwrapped)
  );
  addAllOfPropertyNames(names, unwrapped.allOf);
  return names;
}
