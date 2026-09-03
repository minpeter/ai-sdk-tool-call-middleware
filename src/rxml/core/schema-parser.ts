import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
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

function deepDecodeStringsBySchema(input: unknown, schema: unknown): unknown {
  if (input == null || schema == null) {
    return input;
  }
  const type = getSchemaType(schema);
  if (type === "string" && typeof input === "string") {
    return unescapeXml(input);
  }
  if (type === "array" && Array.isArray(input)) {
    const unwrapped = unwrapJsonSchema(schema) as
      | { items?: unknown }
      | undefined;
    const itemSchema = unwrapped?.items ?? {};
    return input.map((item) => deepDecodeStringsBySchema(item, itemSchema));
  }
  if (type === "object" && input && typeof input === "object") {
    const object = input as Record<string, unknown>;
    const decoded: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      decoded[key] = deepDecodeStringsBySchema(
        object[key],
        getPropertySchema(schema, key)
      );
    }
    return decoded;
  }
  return typeof input === "string" ? unescapeXml(input) : input;
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
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLParseError("Failed to parse XML", cause);
  }
}

function coerceAndDecode(
  input: Record<string, unknown>,
  schema: unknown
): Record<string, unknown> {
  try {
    const coerced = coerceDomBySchema(input, schema);
    return deepDecodeStringsBySchema(coerced, schema) as Record<
      string,
      unknown
    >;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLCoercionError("Failed to coerce by schema", error);
  }
}

export function parse(
  xmlInner: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  const textNodeName = options.textNodeName ?? "#text";
  const xml = normalizeDocumentRoot(xmlInner, schema);
  const topLevelStringProps = getTopLevelStringProps(schema);
  const duplicateKeys = findDuplicateStringKeys(
    xml,
    topLevelStringProps,
    options
  );
  const shielded = shieldStringContent(
    xml,
    getStringTypedProperties(schema),
    options
  );
  const parsed = domToObject(
    parseWrappedNodes(shielded.content, options, textNodeName),
    schema,
    textNodeName
  );
  const restore = createPlaceholderRestorer(shielded.originals, textNodeName);
  const restored = restore(parsed) as Record<string, unknown>;
  const args = processParsedProperties(restored, {
    duplicateKeys,
    originalContent: shielded.originals,
    options,
    schema,
    textNodeName,
    xml,
  });
  backfillStringProperties(args, topLevelStringProps, xml);
  return coerceAndDecode(unwrapUnexpectedRoot(args, schema), schema);
}
