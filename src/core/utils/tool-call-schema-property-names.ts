import { unwrapJsonSchema } from "../../schema-coerce";
import { collectFalsePropertyNames } from "./tool-call-property-deny";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDeclaredProperties(names: Set<string>, properties: unknown): void {
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
  required: unknown,
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

function addAllOfPropertyNames(names: Set<string>, variants: unknown): void {
  if (!Array.isArray(variants)) {
    return;
  }
  for (const variant of variants) {
    for (const name of collectSchemaSelectionPropertyNames(variant)) {
      names.add(name);
    }
  }
}

export function collectSchemaSelectionPropertyNames(
  schema: unknown
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
