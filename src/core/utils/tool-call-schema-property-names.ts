import type { ToolInputSchemaCandidate } from "../../schema/tool-input-schema";
import { unwrapJsonSchema } from "../../schema-coerce";
import { collectFalsePropertyNames } from "./tool-call-property-deny";

type SchemaBoundaryRecord = Readonly<Record<string, ToolInputSchemaCandidate>>;

function isRecord(
  value: ToolInputSchemaCandidate
): value is SchemaBoundaryRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDeclaredProperties(
  names: Set<string>,
  properties: ToolInputSchemaCandidate
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
  required: ToolInputSchemaCandidate,
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
  variants: ToolInputSchemaCandidate
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

export function collectSchemaSelectionPropertyNames(
  schema: ToolInputSchemaCandidate
): Set<string> {
  const names = new Set<string>();
  const unwrapped = unwrapJsonSchema(
    typeof schema === "boolean" || isRecord(schema) ? schema : undefined
  );
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
