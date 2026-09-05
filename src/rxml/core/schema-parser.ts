import { isJSONObject, type JSONObject } from "@ai-sdk/provider";
import {
  isSchemaDefinition,
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaCandidate,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import type { RxmlValue } from "../builders/stringify";
import { RXMLCoercionError, RXMLParseError } from "../errors/types";
import {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
} from "../schema/coercion";
import { unescapeXml } from "../utils/helpers";
import { createPlaceholderRestorer } from "./placeholder-restorer";
import { normalizeDocumentRoot, unwrapUnexpectedRoot } from "./schema-document";
import {
  findDuplicateStringKeys,
  getTopLevelStringProps,
  shieldStringContent,
} from "./schema-placeholders";
import {
  backfillStringProperties,
  processParsedProperties,
} from "./schema-properties";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

type ParsedSchema = ToolInputSchemaDefinition | undefined;
type DecodeTask =
  | {
      readonly key: number;
      readonly kind: "array";
      readonly schema: ParsedSchema;
      readonly target: RxmlValue[];
      readonly value: RxmlValue;
    }
  | {
      readonly key: string;
      readonly kind: "object";
      readonly schema: ParsedSchema;
      readonly target: Record<string, RxmlValue>;
      readonly value: RxmlValue;
    };

function parseSchema(schema: ToolInputSchemaCandidate): ParsedSchema {
  return isSchemaDefinition(schema) ? schema : undefined;
}

function isRxmlRecord(
  value: RxmlValue
): value is Readonly<Record<string, RxmlValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DecodeTraversal {
  readonly decodedContainers: Map<object, RxmlValue>;
  readonly stack: DecodeTask[];
}

function assignDecoded(task: DecodeTask, value: RxmlValue): void {
  if (task.kind === "array") {
    task.target[task.key] = value;
  } else {
    task.target[task.key] = value;
  }
}

function scheduleArrayDecode(
  task: DecodeTask & { readonly value: readonly RxmlValue[] },
  traversal: DecodeTraversal,
  schema: ToolInputSchema
): void {
  const existing = traversal.decodedContainers.get(task.value);
  if (existing !== undefined) {
    assignDecoded(task, existing);
    return;
  }
  const output = Array.from<RxmlValue>({ length: task.value.length });
  traversal.decodedContainers.set(task.value, output);
  assignDecoded(task, output);
  for (let index = task.value.length - 1; index >= 0; index -= 1) {
    const prefixSchema = schema.prefixItems?.[index];
    const itemSchema =
      prefixSchema ??
      (Array.isArray(schema.items) ? schema.items[index] : schema.items);
    traversal.stack.push({
      key: index,
      kind: "array",
      schema: itemSchema,
      target: output,
      value: task.value[index],
    });
  }
}

function scheduleObjectDecode(
  task: DecodeTask & { readonly value: Readonly<Record<string, RxmlValue>> },
  traversal: DecodeTraversal
): void {
  const existing = traversal.decodedContainers.get(task.value);
  if (existing !== undefined) {
    assignDecoded(task, existing);
    return;
  }
  const output: Record<string, RxmlValue> = Object.create(null);
  traversal.decodedContainers.set(task.value, output);
  assignDecoded(task, output);
  const entries = Object.entries(task.value);
  for (const [key, value] of entries.reverse()) {
    traversal.stack.push({
      key,
      kind: "object",
      schema: getPropertySchema(task.schema, key),
      target: output,
      value,
    });
  }
}

function deepDecodeStringsBySchema(
  input: JSONObject,
  schema: ParsedSchema
): JSONObject;
function deepDecodeStringsBySchema(
  input: RxmlValue,
  schema: ParsedSchema
): RxmlValue;
function deepDecodeStringsBySchema(
  input: RxmlValue,
  schema: ParsedSchema
): RxmlValue {
  const root: Record<string, RxmlValue> = Object.create(null);
  const traversal: DecodeTraversal = {
    decodedContainers: new Map<object, RxmlValue>(),
    stack: [
      { key: "value", kind: "object", schema, target: root, value: input },
    ],
  };

  while (traversal.stack.length > 0) {
    const [task] = traversal.stack.splice(-1, 1);
    if (task.value == null || task.schema == null) {
      assignDecoded(task, task.value);
      continue;
    }
    if (typeof task.value === "string") {
      assignDecoded(task, unescapeXml(task.value));
      continue;
    }
    const unwrapped = unwrapJsonSchema(task.schema);
    const schemaType = getSchemaType(unwrapped);
    if (
      schemaType === "array" &&
      Array.isArray(task.value) &&
      isSchemaRecord(unwrapped)
    ) {
      scheduleArrayDecode({ ...task, value: task.value }, traversal, unwrapped);
      continue;
    }
    if (schemaType === "object" && isRxmlRecord(task.value)) {
      scheduleObjectDecode({ ...task, value: task.value }, traversal);
      continue;
    }
    assignDecoded(task, task.value);
  }

  return root.value;
}

function parseWrappedNodes(
  xml: string,
  options: ParseOptions,
  textNodeName: string
): (RXMLNode | string)[] {
  try {
    const tokenizer = new XMLTokenizer(`<root>${xml}</root>`, {
      ...options,
      textNodeName,
    });
    return tokenizer.parseNode().children;
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    throw Object.assign(new RXMLParseError("Failed to parse XML"), {
      cause: normalizedError,
    });
  }
}

function coerceAndDecode(input: JSONObject, schema: ParsedSchema): JSONObject {
  try {
    const coerced = coerceDomBySchema(input, schema);
    return deepDecodeStringsBySchema(coerced, schema);
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    throw Object.assign(new RXMLCoercionError("Failed to coerce by schema"), {
      cause: normalizedError,
    });
  }
}

export function parse(
  xmlInner: string,
  schema: ToolInputSchemaCandidate,
  options: ParseOptions = {}
): JSONObject {
  const parsedSchema = parseSchema(schema);
  const textNodeName = options.textNodeName ?? "#text";
  const xml = normalizeDocumentRoot(xmlInner, parsedSchema);
  const topLevelStringProps = getTopLevelStringProps(parsedSchema);
  const duplicateKeys = findDuplicateStringKeys(
    xml,
    topLevelStringProps,
    options
  );
  const shielded = shieldStringContent(
    xml,
    getStringTypedProperties(parsedSchema),
    options
  );
  const parsed = domToObject(
    parseWrappedNodes(shielded.content, options, textNodeName),
    parsedSchema,
    textNodeName
  );
  const restore = createPlaceholderRestorer(shielded.originals, textNodeName);
  const restored = restore(parsed);
  if (!isJSONObject(restored)) {
    throw new RXMLParseError("Parsed XML did not produce an object");
  }
  const args = processParsedProperties(restored, {
    duplicateKeys,
    originalContent: shielded.originals,
    options,
    schema: parsedSchema,
    textNodeName,
    xml,
  });
  backfillStringProperties(args, topLevelStringProps, xml);
  const unwrapped = unwrapUnexpectedRoot(args, parsedSchema);
  if (!isJSONObject(unwrapped)) {
    throw new RXMLParseError("Parsed XML root did not produce an object");
  }
  return coerceAndDecode(unwrapped, parsedSchema);
}
