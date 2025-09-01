export type JsonSchemaNode = {
  type?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
};

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function deepDecodeStringsBySchema(
  input: unknown,
  schema: JsonSchemaNode
): unknown {
  if (input == null || schema == null) return input;
  const type = schema.type;

  if (type === "string" && typeof input === "string") {
    return decodeXmlEntities(input);
  }

  if (type === "array" && Array.isArray(input)) {
    return input.map(item =>
      deepDecodeStringsBySchema(item, schema.items ?? {})
    );
  }

  if (type === "object" && input && typeof input === "object") {
    const obj: Record<string, unknown> = input as Record<string, unknown>;
    const props: Record<string, JsonSchemaNode> = schema.properties ?? {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const childSchema: JsonSchemaNode = props[key] ?? {};
      out[key] = deepDecodeStringsBySchema(obj[key], childSchema);
    }
    return out;
  }

  if (typeof input === "string") return decodeXmlEntities(input);
  return input;
}

export function getToolSchema(
  tools: Array<{ name?: string; inputSchema?: unknown }>,
  originalSchemas: Record<string, unknown>,
  toolName: string
): unknown {
  const original = originalSchemas[toolName];
  if (original) return original;
  const fallback = tools.find(t => t.name === toolName)?.inputSchema;
  return fallback as unknown;
}
