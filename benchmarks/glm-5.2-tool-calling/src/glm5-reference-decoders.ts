import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";

/**
 * Small, dependency-free reproductions of pinned deployment-reference parser
 * semantics. These decoders are not evidence of the parser used by FreeRouter.
 *
 * vLLM Rust source:
 *   revision 26c909ed74a6298952d0c3191fbfdf2b513d9e1d
 *   rust/src/parser/src/tool/glm_xml/mod.rs
 *   rust/src/parser/src/tool/glm_xml/glm47_moe.rs
 *   source SHA-256:
 *   c6ad055e23f0aaf976e1de105e6d3a152c6c04673926adb47577c5c8bf0d0147
 *   9792c1654ff17cba55897f805bc816a00aa13b89cbcc2c17f1fd02c1301f6ae8
 *
 * SGLang source:
 *   revision 619609aa5a2c4859cee79e9dd16a15cf1ff4c98a
 *   python/sglang/srt/function_call/glm47_moe_detector.py
 *   source snapshot SHA-256:
 *   4ed06f8370249f6dafd91b5a25796851845a028a3ccc79efff2f68b6971a5af1
 */

export const GLM5_REFERENCE_DECODER_SOURCES = {
  sglang: {
    implementation: "sglang-glm47-moe-deployment-reference",
    path: "python/sglang/srt/function_call/glm47_moe_detector.py",
    revision: "619609aa5a2c4859cee79e9dd16a15cf1ff4c98a",
    sha256: "4ed06f8370249f6dafd91b5a25796851845a028a3ccc79efff2f68b6971a5af1",
  },
  vllm: {
    implementation: "vllm-rust-glm47-moe-deployment-reference",
    paths: [
      "rust/src/parser/src/tool/glm_xml/glm47_moe.rs",
      "rust/src/parser/src/tool/glm_xml/mod.rs",
    ],
    revision: "26c909ed74a6298952d0c3191fbfdf2b513d9e1d",
    sha256: [
      "c6ad055e23f0aaf976e1de105e6d3a152c6c04673926adb47577c5c8bf0d0147",
      "9792c1654ff17cba55897f805bc816a00aa13b89cbcc2c17f1fd02c1301f6ae8",
    ],
  },
  "vllm-python": {
    implementation: "vllm-python-glm47-moe-deployment-reference",
    path: "vllm/parser/glm47_moe.py",
    revision: "26c909ed74a6298952d0c3191fbfdf2b513d9e1d",
    sha256: "ce3629319e56e882d25cb75d62e3e7088a4eec1518885fc69fc696eafb4a97b2",
  },
} as const;

export type Glm5ReferenceDecoderId =
  keyof typeof GLM5_REFERENCE_DECODER_SOURCES;

export interface Glm5DecodedCall {
  arguments: Record<string, unknown>;
  name: string;
}

export interface Glm5ReferenceDecodeResult {
  accepted: boolean;
  calls: Glm5DecodedCall[];
  errors: string[];
  matchedToolCallCount: number;
  parser: Glm5ReferenceDecoderId;
  text: string;
}

interface ToolDescriptor {
  inputSchema: unknown;
  name: string;
}

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const ARG_KEY_OPEN = "<arg_key>";
const ARG_KEY_CLOSE = "</arg_key>";
const ARG_VALUE_OPEN = "<arg_value>";
const ARG_VALUE_CLOSE = "</arg_value>";
const INTEGER_PATTERN = /^[-+]?\d+$/u;
const NUMBER_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu;
const TOOL_NAME_PATTERN = /^[^\s<]+/u;
const PYTHON_KEYWORD_PATTERN = /^(True|False|None)\b/u;
const WHITESPACE_PATTERN = /\s/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolDescriptors(
  tools: readonly LanguageModelV4FunctionTool[]
): ToolDescriptor[] {
  return tools.map((tool) => ({
    inputSchema: tool.inputSchema,
    name: tool.name,
  }));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: JSON Schema combinators require explicit recursive branches.
function schemaTypes(schema: Record<string, unknown>): Set<string> {
  const output = new Set<string>();
  const { type } = schema;
  if (typeof type === "string") {
    output.add(type);
  } else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item === "string") {
        output.add(item);
      }
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      const record = asRecord(branch);
      if (record) {
        for (const branchType of schemaTypes(record)) {
          output.add(branchType);
        }
      }
    }
  }
  if (output.size === 0) {
    if (asRecord(schema.properties)) {
      output.add("object");
    } else if (asRecord(schema.items)) {
      output.add("array");
    }
  }
  return output;
}

function parseJsonContainer(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the pinned reference has ordered scalar coercion fallbacks.
function coerceScalarByTypes(
  value: string,
  types: ReadonlySet<string>
): unknown {
  const trimmed = value.trim();
  if (types.has("null") && trimmed === "null") {
    return null;
  }
  if (types.has("boolean")) {
    if (trimmed === "true") {
      return true;
    }
    if (trimmed === "false") {
      return false;
    }
  }
  if (types.has("integer") && INTEGER_PATTERN.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  if (types.has("number") && NUMBER_PATTERN.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (
    (types.has("object") || types.has("array")) &&
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return parseJsonContainer(trimmed);
  }
  return value;
}

function coerceBySchema(value: unknown, schema: unknown): unknown {
  const schemaRecord = asRecord(schema);
  if (!schemaRecord) {
    return value;
  }
  if (typeof value === "string") {
    const coerced = coerceScalarByTypes(value, schemaTypes(schemaRecord));
    return coerced === value ? value : coerceBySchema(coerced, schemaRecord);
  }
  if (Array.isArray(value)) {
    const itemSchema = schemaRecord.items;
    return itemSchema === undefined
      ? value
      : value.map((item) => coerceBySchema(item, itemSchema));
  }
  const record = asRecord(value);
  const properties = asRecord(schemaRecord.properties);
  if (!(record && properties)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      properties[key] === undefined
        ? item
        : coerceBySchema(item, properties[key]),
    ])
  );
}

function toolPropertySchema(tool: ToolDescriptor, key: string): unknown {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  return properties?.[key];
}

function vllmRustBody(
  body: string,
  toolsByName: ReadonlyMap<string, ToolDescriptor>
): Glm5DecodedCall | null {
  let cursor = 0;
  while (WHITESPACE_PATTERN.test(body.charAt(cursor))) {
    cursor += 1;
  }
  const nameMatch = TOOL_NAME_PATTERN.exec(body.slice(cursor));
  if (!nameMatch) {
    return null;
  }
  const [name] = nameMatch;
  cursor += name.length;
  const tool = toolsByName.get(name);
  const arguments_: Record<string, unknown> = {};
  while (cursor < body.length) {
    while (WHITESPACE_PATTERN.test(body.charAt(cursor))) {
      cursor += 1;
    }
    if (cursor === body.length) {
      break;
    }
    if (!body.startsWith(ARG_KEY_OPEN, cursor)) {
      return null;
    }
    cursor += ARG_KEY_OPEN.length;
    const keyClose = body.indexOf(ARG_KEY_CLOSE, cursor);
    if (keyClose === -1 || keyClose === cursor) {
      return null;
    }
    const key = body.slice(cursor, keyClose).trim();
    cursor = keyClose + ARG_KEY_CLOSE.length;
    while (WHITESPACE_PATTERN.test(body.charAt(cursor))) {
      cursor += 1;
    }
    if (!body.startsWith(ARG_VALUE_OPEN, cursor)) {
      return null;
    }
    cursor += ARG_VALUE_OPEN.length;
    const valueClose = body.indexOf(ARG_VALUE_CLOSE, cursor);
    if (valueClose === -1) {
      return null;
    }
    const rawValue = body.slice(cursor, valueClose).trim();
    arguments_[key] = coerceBySchema(
      rawValue,
      tool ? toolPropertySchema(tool, key) : undefined
    );
    cursor = valueClose + ARG_VALUE_CLOSE.length;
  }
  return { arguments: arguments_, name };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this bounded scanner mirrors ast.literal_eval-compatible quoting without executing code.
function pythonLiteralToJson(input: string): string | null {
  let output = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index);
    if (quote !== null) {
      if (escaped) {
        if (quote === "'" && character === "'") {
          output += "'";
        } else if (character === '"') {
          output += '\\"';
        } else {
          output += `\\${character}`;
        }
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        output += '"';
        quote = null;
      } else if (character === '"') {
        output += '\\"';
      } else {
        output += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += '"';
      continue;
    }
    const suffix = input.slice(index);
    const keyword = PYTHON_KEYWORD_PATTERN.exec(suffix)?.[1];
    if (keyword) {
      const replacements: Record<string, string> = {
        False: "false",
        None: "null",
        True: "true",
      };
      output += replacements[keyword] ?? keyword;
      index += keyword.length - 1;
      continue;
    }
    if (character === "(" || character === ")") {
      output += character === "(" ? "[" : "]";
    } else {
      output += character;
    }
  }
  return quote === null && !escaped ? output : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered JSON, escaped JSON, Python literal, and string fallbacks mirror the pinned detector.
function sglangParseValue(rawValue: string, schema: unknown): unknown {
  let parsed: unknown;
  let parsedSuccessfully = false;
  try {
    parsed = JSON.parse(rawValue) as unknown;
    parsedSuccessfully = true;
  } catch {
    try {
      const unescaped = JSON.parse(`{"tmp":"${rawValue}"}`) as {
        tmp: string;
      };
      parsed = JSON.parse(unescaped.tmp) as unknown;
      parsedSuccessfully = true;
    } catch {
      const jsonish = pythonLiteralToJson(rawValue.trim());
      if (jsonish === null) {
        parsed = rawValue;
      } else {
        try {
          parsed = JSON.parse(jsonish) as unknown;
          parsedSuccessfully = true;
        } catch {
          parsed = rawValue;
        }
      }
    }
  }
  if (!parsedSuccessfully) {
    parsed = String(rawValue);
  }

  const schemaRecord = asRecord(schema);
  const types = schemaRecord ? schemaTypes(schemaRecord) : new Set<string>();
  if (types.size === 1 && types.has("string")) {
    if (typeof parsed === "string") {
      return parsed;
    }
    return typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
  }
  if (types.has("number") && typeof parsed === "string") {
    return coerceScalarByTypes(parsed, new Set(["number"]));
  }
  return parsed;
}

function sglangArguments(
  body: string,
  tool: ToolDescriptor
): Record<string, unknown> {
  const arguments_: Record<string, unknown> = {};
  const pairPattern =
    /<arg_key>(.*?)<\/arg_key>(?:\\n|\s)*<arg_value>(.*?)<\/arg_value>/gsu;
  for (const match of body.matchAll(pairPattern)) {
    const key = (match[1] ?? "").trim();
    if (!key) {
      continue;
    }
    arguments_[key] = sglangParseValue(
      match[2] ?? "",
      toolPropertySchema(tool, key)
    );
  }
  return arguments_;
}

function vllmPythonArguments(body: string): Record<string, unknown> {
  const arguments_: Record<string, unknown> = {};
  const pairPattern =
    /<arg_key>(.*?)<\/arg_key>\s*<arg_value>(.*?)<\/arg_value>/gsu;
  for (const match of body.matchAll(pairPattern)) {
    const key = (match[1] ?? "").trim();
    if (key) {
      arguments_[key] = match[2] ?? "";
    }
  }
  return arguments_;
}

function removeRanges(text: string, ranges: [number, number][]): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const [start, end] of ranges) {
    parts.push(text.slice(cursor, start));
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Reproduce the pinned vLLM GLM47 parser's final-call semantics. */
export function decodeWithVllmGlm47Reference(
  text: string,
  inputTools: readonly LanguageModelV4FunctionTool[]
): Glm5ReferenceDecodeResult {
  const tools = toolDescriptors(inputTools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: Glm5DecodedCall[] = [];
  const errors: string[] = [];
  const consumed: [number, number][] = [];
  let cursor = 0;
  let matchedToolCallCount = 0;

  while (cursor < text.length) {
    const open = text.indexOf(TOOL_CALL_OPEN, cursor);
    if (open === -1) {
      break;
    }
    matchedToolCallCount += 1;
    const bodyStart = open + TOOL_CALL_OPEN.length;
    const explicitClose = text.indexOf(TOOL_CALL_CLOSE, bodyStart);
    if (explicitClose === -1) {
      errors.push("vLLM reference found <tool_call> without </tool_call>.");
      break;
    }
    const bodyEnd = explicitClose;
    const end = explicitClose + TOOL_CALL_CLOSE.length;
    const body = text.slice(bodyStart, bodyEnd);
    const parsed = vllmRustBody(body, byName);
    consumed.push([open, end]);
    if (parsed) {
      calls.push(parsed);
    } else {
      errors.push("Malformed vLLM Rust reference tool-call body.");
    }
    cursor = end;
  }

  return {
    accepted: calls.length > 0,
    calls,
    errors,
    matchedToolCallCount,
    parser: "vllm",
    text: removeRanges(text, consumed).trim(),
  };
}

/** Reproduce the pinned vLLM Python parser-engine adapter separately. */
export function decodeWithVllmPythonGlm47Reference(
  text: string,
  inputTools: readonly LanguageModelV4FunctionTool[]
): Glm5ReferenceDecodeResult {
  const tools = toolDescriptors(inputTools);
  const knownNames = new Set(tools.map((tool) => tool.name));
  const calls: Glm5DecodedCall[] = [];
  const errors: string[] = [];
  const consumed: [number, number][] = [];
  let cursor = 0;
  let matchedToolCallCount = 0;
  while (cursor < text.length) {
    const open = text.indexOf(TOOL_CALL_OPEN, cursor);
    if (open === -1) {
      break;
    }
    matchedToolCallCount += 1;
    const bodyStart = open + TOOL_CALL_OPEN.length;
    const close = text.indexOf(TOOL_CALL_CLOSE, bodyStart);
    if (close === -1) {
      errors.push(
        "vLLM Python reference found <tool_call> without </tool_call>."
      );
      break;
    }
    const end = close + TOOL_CALL_CLOSE.length;
    const body = text.slice(bodyStart, close);
    const firstArg = body.indexOf(ARG_KEY_OPEN);
    const name = body.slice(0, firstArg === -1 ? body.length : firstArg).trim();
    consumed.push([open, end]);
    if (knownNames.has(name)) {
      calls.push({ arguments: vllmPythonArguments(body), name });
    } else {
      errors.push(
        `Unknown or empty vLLM Python reference tool name: ${name || "<empty>"}`
      );
    }
    cursor = end;
  }
  return {
    accepted: calls.length > 0,
    calls,
    errors,
    matchedToolCallCount,
    parser: "vllm-python",
    text: removeRanges(text, consumed).trim(),
  };
}

/** Reproduce the pinned SGLang detector's non-streaming regex semantics. */
export function decodeWithSglangGlm47Reference(
  text: string,
  inputTools: readonly LanguageModelV4FunctionTool[]
): Glm5ReferenceDecodeResult {
  const tools = toolDescriptors(inputTools);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: Glm5DecodedCall[] = [];
  const errors: string[] = [];
  const consumed: [number, number][] = [];
  const outerPattern = /<tool_call>.*?<\/tool_call>/gsu;
  let matchedToolCallCount = 0;

  for (const match of text.matchAll(outerPattern)) {
    const [raw] = match;
    const start = match.index;
    consumed.push([start, start + raw.length]);
    matchedToolCallCount += 1;
    const body = raw.slice(TOOL_CALL_OPEN.length, -TOOL_CALL_CLOSE.length);
    const firstArg = body.indexOf(ARG_KEY_OPEN);
    const name = body.slice(0, firstArg === -1 ? body.length : firstArg);
    const tool = byName.get(name);
    if (!tool) {
      errors.push(
        `Unknown or empty SGLang reference tool name: ${name || "<empty>"}`
      );
      continue;
    }
    calls.push({ arguments: sglangArguments(body, tool), name });
  }
  if (text.includes(TOOL_CALL_OPEN) && matchedToolCallCount === 0) {
    errors.push(
      "SGLang reference found <tool_call> without a complete outer close."
    );
  }

  return {
    accepted: calls.length > 0,
    calls,
    errors,
    matchedToolCallCount,
    parser: "sglang",
    text: removeRanges(text, consumed).trim(),
  };
}

export function decodeWithGlm5Reference(
  parser: Glm5ReferenceDecoderId,
  text: string,
  tools: readonly LanguageModelV4FunctionTool[]
): Glm5ReferenceDecodeResult {
  if (parser === "vllm") {
    return decodeWithVllmGlm47Reference(text, tools);
  }
  if (parser === "vllm-python") {
    return decodeWithVllmPythonGlm47Reference(text, tools);
  }
  return decodeWithSglangGlm47Reference(text, tools);
}
