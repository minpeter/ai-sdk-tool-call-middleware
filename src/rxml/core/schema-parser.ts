import { isJSONObject, type JSONObject } from "@ai-sdk/provider";
import {
  isSchemaDefinition,
  isSchemaRecord,
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

interface DecodeTraversal {
  readonly decodedContainers: Map<object, RxmlValue>;
  readonly stack: DecodeTask[];
}

function assignDecoded(task: DecodeTask, value: RxmlValue): void {
  switch (task.kind) {
    case "array":
      task.target[task.key] = value;
      return;
    case "object":
      task.target[task.key] = value;
      return;
    default: {
      const unreachable: never = task;
      throw new TypeError(`Unhandled decode task: ${String(unreachable)}`);
    }
  }
}

function scheduleArrayDecode(
  task: DecodeTask,
  traversal: DecodeTraversal
): boolean {
  if (!Array.isArray(task.value)) {
    return false;
  }
  const existing = traversal.decodedContainers.get(task.value);
  if (existing !== undefined) {
    assignDecoded(task, existing);
    return true;
  }
  const output = Array.from<RxmlValue>({ length: task.value.length });
  traversal.decodedContainers.set(task.value, output);
  assignDecoded(task, output);
  const unwrapped = unwrapJsonSchema(task.schema);
  const schemaObject =
    typeof unwrapped === "object" && isSchemaRecord(unwrapped)
      ? unwrapped
      : undefined;
  for (let index = task.value.length - 1; index >= 0; index -= 1) {
    const prefixSchema = schemaObject?.prefixItems?.[index];
    const itemSchema =
      prefixSchema ??
      (Array.isArray(schemaObject?.items)
        ? schemaObject.items[index]
        : schemaObject?.items);
    traversal.stack.push({
      key: index,
      kind: "array",
      schema: itemSchema,
      target: output,
      value: task.value[index],
    });
  }
  return true;
}

function scheduleObjectDecode(
  task: DecodeTask,
  traversal: DecodeTraversal
): boolean {
  if (
    typeof task.value !== "object" ||
    task.value === null ||
    Array.isArray(task.value)
  ) {
    return false;
  }
  const existing = traversal.decodedContainers.get(task.value);
  if (existing !== undefined) {
    assignDecoded(task, existing);
    return true;
  }
  const output: Record<string, RxmlValue> = Object.create(null);
  traversal.decodedContainers.set(task.value, output);
  assignDecoded(task, output);
  const entries = Object.entries(task.value);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const [key, value] = entry;
    traversal.stack.push({
      key,
      kind: "object",
      schema: getPropertySchema(task.schema, key),
      target: output,
      value,
    });
  }
  return true;
}

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
    const task = traversal.stack.pop();
    if (task === undefined) {
      break;
    }
    if (task.value == null || task.schema == null) {
      assignDecoded(task, task.value);
      continue;
    }
    if (typeof task.value === "string") {
      assignDecoded(task, unescapeXml(task.value));
      continue;
    }
    const schemaType = getSchemaType(task.schema);
    if (
      (schemaType === "array" && scheduleArrayDecode(task, traversal)) ||
      (schemaType === "object" && scheduleObjectDecode(task, traversal))
    ) {
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
    if (!isJSONObject(coerced)) {
      throw new TypeError("RXML schema coercion returned a non-object value");
    }
    const decoded = deepDecodeStringsBySchema(coerced, schema);
    if (!isJSONObject(decoded)) {
      throw new TypeError("RXML schema decoding returned a non-object value");
    }
    return decoded;
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
