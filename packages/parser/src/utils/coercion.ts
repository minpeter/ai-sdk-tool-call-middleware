import type { LanguageModelV2Content } from "@ai-sdk/provider";

export function unwrapJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (s.jsonSchema && typeof s.jsonSchema === "object") {
    return unwrapJsonSchema(s.jsonSchema);
  }
  return schema;
}

export function getSchemaType(schema: unknown): string | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const t: unknown = (unwrapped as Record<string, unknown>).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    const preferred = [
      "object",
      "array",
      "boolean",
      "number",
      "integer",
      "string",
    ];
    for (const p of preferred) if (t.includes(p)) return p;
  }
  const s = unwrapped as Record<string, unknown>;
  if (s && typeof s === "object" && (s.properties || s.additionalProperties)) {
    return "object";
  }
  if (s && typeof s === "object" && (s.items || (s as any).prefixItems)) {
    return "array";
  }
  return undefined;
}

export function coerceBySchema(value: unknown, schema?: unknown): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    if (typeof value === "string") {
      const s = value.trim();
      const lower = s.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
        const num = Number(s);
        if (Number.isFinite(num)) return num;
      }

      // Fallback: try parsing JSON-like strings when no schema info
      if (
        (s.startsWith("{") && s.endsWith("}")) ||
        (s.startsWith("[") && s.endsWith("]"))
      ) {
        try {
          const parsed = JSON.parse(s);
          // Recursively apply coercion to the parsed value without schema
          return coerceBySchema(parsed, undefined);
        } catch {
          // If parsing fails, return original value
        }
      }
    }

    return value;
  }

  const schemaType = getSchemaType(unwrapped);

  if (typeof value === "string") {
    const s = value.trim();
    if (schemaType === "object") {
      try {
        // Better normalization for JSON strings with newlines and indentation
        let normalized = s.replace(/'/g, '"');
        // Handle empty object cases
        normalized = normalized.replace(/^\{\s*\}$/s, "{}");

        const obj = JSON.parse(normalized);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const props = (unwrapped as Record<string, unknown>).properties as
            | Record<string, unknown>
            | undefined;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            const propSchema = props ? (props[k] as unknown) : undefined;
            out[k] =
              typeof propSchema === "boolean"
                ? v
                : coerceBySchema(v, propSchema);
          }
          return out;
        }
      } catch {
        // fallthrough
      }
    }
    if (schemaType === "array") {
      try {
        const normalized = s.replace(/'/g, '"');
        const arr = JSON.parse(normalized);
        if (Array.isArray(arr)) {
          const u = unwrapped as Record<string, unknown>;
          const prefixItems = Array.isArray((u as any).prefixItems)
            ? ((u as any).prefixItems as unknown[])
            : undefined;
          const itemsSchema = u.items as unknown;
          if (prefixItems && arr.length === prefixItems.length) {
            return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
          }
          return arr.map(v => coerceBySchema(v, itemsSchema));
        }
      } catch {
        const csv = s.includes("\n") ? s.split(/\n+/) : s.split(/,\s*/);
        const trimmed = csv.map(x => x.trim()).filter(x => x.length > 0);
        const u = unwrapped as Record<string, unknown>;
        const prefixItems = Array.isArray((u as any).prefixItems)
          ? ((u as any).prefixItems as unknown[])
          : undefined;
        const itemsSchema = u.items as unknown;
        if (prefixItems && trimmed.length === prefixItems.length) {
          return trimmed.map((x, i) => coerceBySchema(x, prefixItems[i]));
        }
        return trimmed.map(x => coerceBySchema(x, itemsSchema));
      }
    }
  }

  if (
    schemaType === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const out: Record<string, unknown> = {};
    const props = (unwrapped as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props ? (props[k] as unknown) : undefined;
      out[k] =
        typeof propSchema === "boolean" ? v : coerceBySchema(v, propSchema);
    }
    return out;
  }

  if (schemaType === "array") {
    const u = unwrapped as Record<string, unknown>;
    const itemsSchema = u.items as unknown;
    const prefixItems = Array.isArray((u as any).prefixItems)
      ? ((u as any).prefixItems as unknown[])
      : undefined;

    if (Array.isArray(value)) {
      if (prefixItems && value.length === prefixItems.length) {
        return value.map((v, i) => coerceBySchema(v, prefixItems[i]));
      }
      return value.map(v => coerceBySchema(v, itemsSchema));
    }

    if (value && typeof value === "object") {
      const maybe = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(maybe, "item")) {
        const items = (maybe as any).item as unknown;
        const arr = Array.isArray(items) ? items : [items];
        if (prefixItems && arr.length === prefixItems.length) {
          return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
        }
        return arr.map(v => coerceBySchema(v, itemsSchema));
      }

      // Special handling for objects with array-like field names that might represent arrays
      // This commonly happens when models output <multiples><number>3</number><number>5</number></multiples>
      // which gets parsed as { "number": ["3", "5"] }
      const keys = Object.keys(maybe);

      // Check for single field that contains an array (common XML pattern)
      if (keys.length === 1) {
        const singleKey = keys[0];
        const singleValue = maybe[singleKey];
        if (Array.isArray(singleValue)) {
          const coercedArray = singleValue.map(v =>
            coerceBySchema(v, itemsSchema)
          );
          return coercedArray;
        }
      }

      // Check for numeric keys (traditional tuple handling)
      if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
        const arr = keys
          .sort((a, b) => Number(a) - Number(b))
          .map(k => (maybe as any)[k]);
        if (prefixItems && arr.length === prefixItems.length) {
          return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
        }
        return arr.map(v => coerceBySchema(v, itemsSchema));
      }
    }

    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (prefixItems && prefixItems.length > 0) {
        return [coerceBySchema(value, prefixItems[0])];
      }
      return [coerceBySchema(value, itemsSchema)];
    }
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (schemaType === "boolean") {
      const lower = s.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    if (schemaType === "number" || schemaType === "integer") {
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
        const num = Number(s);
        if (Number.isFinite(num)) return num;
      }
    }
  }

  return value;
}

export function fixToolCallWithSchema(
  part: LanguageModelV2Content,
  tools: Array<{ name?: string; inputSchema?: unknown }>
): LanguageModelV2Content {
  if ((part as { type?: string }).type !== "tool-call") return part;
  const tc = part as unknown as { toolName: string; input: unknown };
  let args: unknown = {};
  if (typeof tc.input === "string") {
    try {
      args = JSON.parse(tc.input);
    } catch {
      return part;
    }
  } else if (tc.input && typeof tc.input === "object") {
    args = tc.input;
  }
  const schema = tools.find(t => t.name === tc.toolName)
    ?.inputSchema as unknown;
  const coerced = coerceBySchema(args, schema);
  return {
    ...(part as Record<string, unknown>),
    input: JSON.stringify(coerced ?? {}),
  } as LanguageModelV2Content;
}

// Wrapper retained for backward compatibility with previous internal helper name
export function coerceToolCallInput(
  part: LanguageModelV2Content,
  tools: Array<{ name?: string; inputSchema?: unknown }>
): LanguageModelV2Content {
  return fixToolCallWithSchema(part, tools);
}
