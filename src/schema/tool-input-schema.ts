import type { JSONArray, JSONObject, JSONValue } from "@ai-sdk/provider";
import type { JSONSchema7 } from "json-schema";

/** JSON Schema dialect accepted by tool-call middleware. */
export type ToolInputSchemaDefinition = boolean | ToolInputSchema;

interface StandardSchemaMarker {
  readonly "~standard": {
    readonly vendor: string;
    readonly version: 1;
  };
}

/** Values accepted at an untrusted schema boundary before narrowing. */
export type ToolInputSchemaCandidate =
  | ToolInputSchemaDefinition
  | JSONValue
  | StandardSchemaMarker
  | undefined;

/**
 * Draft-07 schema plus the two schema containers consumed by this package.
 *
 * Recursive fields are redeclared so extensions remain typed at every depth
 * without augmenting the upstream `json-schema` module.
 */
export interface ToolInputSchema extends JSONSchema7 {
  $defs?: Record<string, ToolInputSchemaDefinition>;
  additionalItems?: ToolInputSchemaDefinition;
  additionalProperties?: ToolInputSchemaDefinition;
  allOf?: ToolInputSchemaDefinition[];
  anyOf?: ToolInputSchemaDefinition[];
  contains?: ToolInputSchemaDefinition;
  definitions?: Record<string, ToolInputSchemaDefinition>;
  dependencies?: Record<string, ToolInputSchemaDefinition | string[]>;
  else?: ToolInputSchemaDefinition;
  if?: ToolInputSchemaDefinition;
  items?: ToolInputSchemaDefinition | ToolInputSchemaDefinition[];
  jsonSchema?: ToolInputSchemaDefinition;
  not?: ToolInputSchemaDefinition;
  oneOf?: ToolInputSchemaDefinition[];
  patternProperties?: Record<string, ToolInputSchemaDefinition>;
  prefixItems?: ToolInputSchemaDefinition[];
  properties?: Record<string, ToolInputSchemaDefinition>;
  propertyNames?: ToolInputSchemaDefinition;
  then?: ToolInputSchemaDefinition;
}

export function isSchemaRecord(
  value: ToolInputSchemaCandidate
): value is ToolInputSchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function normalizeToolInputSchema(
  inputSchema: JSONSchema7 | string
): ToolInputSchema | string {
  if (typeof inputSchema !== "string") {
    return isSchemaRecord(inputSchema)
      ? inputSchema
      : JSON.stringify(inputSchema);
  }

  try {
    const parsed: ToolInputSchemaCandidate = JSON.parse(inputSchema);
    return isSchemaRecord(parsed) ? parsed : inputSchema;
  } catch {
    return inputSchema;
  }
}

export function isSchemaDefinition(
  value: ToolInputSchemaCandidate
): value is ToolInputSchemaDefinition {
  return typeof value === "boolean" || isSchemaRecord(value);
}

interface JsonBoundaryWork {
  readonly entering: boolean;
  readonly value: JSONValue | undefined;
}

type JsonContainer = JSONArray | JSONObject;

const JSON_LEAF_TYPES = new Set(["boolean", "number", "string", "undefined"]);

function isJsonLeaf(
  value: JSONValue | undefined
): value is boolean | null | number | string | undefined {
  return value === null || JSON_LEAF_TYPES.has(typeof value);
}

function isJsonContainer(value: JsonContainer): boolean {
  return Array.isArray(value) || isSchemaRecord(value);
}

export function isCycleSafeJsonValue(value: JSONValue | undefined): boolean {
  const active = new Set<JsonContainer>();
  const work: JsonBoundaryWork[] = [{ entering: true, value }];
  while (work.length > 0) {
    const [current] = work.splice(-1, 1);
    const candidate = current.value;
    if (isJsonLeaf(candidate)) {
      continue;
    }
    if (!isJsonContainer(candidate)) {
      return false;
    }
    if (current.entering) {
      if (active.has(candidate)) {
        return false;
      }
      active.add(candidate);
      work.push({ entering: false, value: candidate });
      for (const child of Array.isArray(candidate)
        ? candidate
        : Object.values(candidate)) {
        work.push({ entering: true, value: child });
      }
    } else {
      active.delete(candidate);
    }
  }
  return true;
}
