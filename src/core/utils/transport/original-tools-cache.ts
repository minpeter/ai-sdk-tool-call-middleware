import type {
  JSONSchema7,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { OnErrorFn } from "../diagnostics/on-error";

export interface EncodedOriginalTool {
  inputSchema: string; // stringified JSONSchema7
  name: string;
}

export interface DecodeOriginalToolsOptions {
  onError?: OnErrorFn;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function freezeDecodedTools(
  tools: LanguageModelV4FunctionTool[]
): LanguageModelV4FunctionTool[] {
  for (const tool of tools) {
    deepFreeze(tool.inputSchema);
    Object.freeze(tool);
  }
  Object.freeze(tools);
  return tools;
}

interface EncodedOriginalToolsCacheEntry {
  decodedTools: LanguageModelV4FunctionTool[];
  encodedEntries: Array<{
    entry: EncodedOriginalTool;
    inputSchema: string;
    name: string;
  }>;
}

interface SharedOriginalToolsCacheEntry {
  decodedTools: LanguageModelV4FunctionTool[];
  encodedValues: Array<{ inputSchema: string; name: string }>;
}

const MAX_SHARED_ORIGINAL_TOOL_CATALOGS = 16;

const encodedOriginalToolsCache = new WeakMap<
  EncodedOriginalTool[],
  EncodedOriginalToolsCacheEntry
>();
const sharedOriginalToolsCache: SharedOriginalToolsCacheEntry[] = [];
const nativeArrayMap = Array.prototype.map;
const { apply: applyFunction } = Reflect;

function encodedOriginalToolsSignature(
  encodedTools: EncodedOriginalTool[]
): string | null {
  const parts = [String(encodedTools.length), "|"];
  for (const entry of encodedTools) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      typeof entry.inputSchema !== "string"
    ) {
      return null;
    }
    parts.push(
      String(entry.name.length),
      ":",
      entry.name,
      String(entry.inputSchema.length),
      ":",
      entry.inputSchema
    );
  }
  return parts.join("");
}

function nativeEncodedCatalogIsCacheable(
  encodedTools: EncodedOriginalTool[]
): boolean {
  const valid = encodedTools.length >= 0;
  for (const entry of encodedTools) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      typeof entry.inputSchema !== "string"
    ) {
      return false;
    }
  }
  return valid;
}

function sharedCatalogMatches(
  cached: SharedOriginalToolsCacheEntry,
  encodedTools: EncodedOriginalTool[]
): boolean {
  if (cached.encodedValues.length !== encodedTools.length) {
    return false;
  }
  for (let index = 0; index < encodedTools.length; index += 1) {
    const snapshot = cached.encodedValues[index];
    const encoded = encodedTools[index];
    if (
      !(snapshot && encoded) ||
      snapshot.name !== encoded.name ||
      snapshot.inputSchema !== encoded.inputSchema
    ) {
      return false;
    }
  }
  return true;
}

function legacySharedCatalogMatches(
  cached: SharedOriginalToolsCacheEntry,
  encodedTools: EncodedOriginalTool[]
): boolean {
  return (
    cached.encodedValues.length === encodedTools.length &&
    cached.encodedValues.every(
      (snapshot, index) =>
        snapshot.name === encodedTools[index]?.name &&
        snapshot.inputSchema === encodedTools[index]?.inputSchema
    )
  );
}

function sharedCatalogIndex(encodedTools: EncodedOriginalTool[]): number {
  for (let index = 0; index < sharedOriginalToolsCache.length; index += 1) {
    const cached = sharedOriginalToolsCache[index];
    if (cached && sharedCatalogMatches(cached, encodedTools)) {
      return index;
    }
  }
  return -1;
}

function sharedCatalogIndexForSignature(signature: string): number {
  for (let index = 0; index < sharedOriginalToolsCache.length; index += 1) {
    const cached = sharedOriginalToolsCache[index];
    if (
      cached &&
      encodedOriginalToolsSignature(cached.encodedValues) === signature
    ) {
      return index;
    }
  }
  return -1;
}

function promoteSharedCatalog(
  index: number
): SharedOriginalToolsCacheEntry | undefined {
  const shared = sharedOriginalToolsCache[index];
  if (!shared) {
    return;
  }
  for (let cursor = index; cursor > 0; cursor -= 1) {
    sharedOriginalToolsCache[cursor] = sharedOriginalToolsCache[
      cursor - 1
    ] as SharedOriginalToolsCacheEntry;
  }
  sharedOriginalToolsCache[0] = shared;
  return shared;
}

function insertSharedCatalog(shared: SharedOriginalToolsCacheEntry): void {
  const lastIndex = Math.min(
    sharedOriginalToolsCache.length,
    MAX_SHARED_ORIGINAL_TOOL_CATALOGS - 1
  );
  for (let index = lastIndex; index > 0; index -= 1) {
    sharedOriginalToolsCache[index] = sharedOriginalToolsCache[
      index - 1
    ] as SharedOriginalToolsCacheEntry;
  }
  sharedOriginalToolsCache[0] = shared;
  if (sharedOriginalToolsCache.length > MAX_SHARED_ORIGINAL_TOOL_CATALOGS) {
    sharedOriginalToolsCache.length = MAX_SHARED_ORIGINAL_TOOL_CATALOGS;
  }
}

function cacheEncodedOriginalTools(
  encodedTools: EncodedOriginalTool[],
  decodedTools: LanguageModelV4FunctionTool[]
): void {
  encodedOriginalToolsCache.set(encodedTools, {
    decodedTools,
    encodedEntries: encodedTools.map((entry) => ({
      entry,
      inputSchema: entry.inputSchema,
      name: entry.name,
    })),
  });
}

export function encodeOriginalTools(
  tools: LanguageModelV4FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  const mapTools = tools?.map;
  if (tools != null && typeof mapTools !== "function") {
    throw new TypeError("tools?.map is not a function");
  }
  const encodedTools = mapTools
    ? ((applyFunction(mapTools, tools, [
        (t: LanguageModelV4FunctionTool) => ({
          name: t.name,
          inputSchema: JSON.stringify(t.inputSchema),
        }),
      ]) || []) as EncodedOriginalTool[])
    : [];
  const usesNativeArrayMap = mapTools === nativeArrayMap;
  // A custom map can legally return an Array Proxy. Preserve the former
  // signature iterator and exact-match transcript only on that cold path;
  // native Array.map output uses the allocation-free exact-entry LRU.
  const legacySignature = usesNativeArrayMap
    ? undefined
    : encodedOriginalToolsSignature(encodedTools);
  const nativeCatalogIsCacheable = usesNativeArrayMap
    ? nativeEncodedCatalogIsCacheable(encodedTools)
    : false;
  let sharedIndex = -1;
  if (usesNativeArrayMap && nativeCatalogIsCacheable) {
    sharedIndex = sharedCatalogIndex(encodedTools);
  } else if (legacySignature) {
    sharedIndex = sharedCatalogIndexForSignature(legacySignature);
  }
  if (sharedIndex >= 0) {
    const shared = sharedOriginalToolsCache[sharedIndex];
    if (
      shared &&
      (usesNativeArrayMap || legacySharedCatalogMatches(shared, encodedTools))
    ) {
      promoteSharedCatalog(sharedIndex);
      cacheEncodedOriginalTools(encodedTools, shared.decodedTools);
      return encodedTools;
    }
  }

  const decodedTools = decodeOriginalTools(encodedTools);
  if (
    decodedTools.length === encodedTools.length &&
    ((usesNativeArrayMap && nativeCatalogIsCacheable) || legacySignature)
  ) {
    const immutableTools = freezeDecodedTools(decodedTools);
    cacheEncodedOriginalTools(encodedTools, immutableTools);
    insertSharedCatalog({
      decodedTools: immutableTools,
      encodedValues: encodedTools.map(({ inputSchema, name }) => ({
        inputSchema,
        name,
      })),
    });
  }
  return encodedTools;
}

export function decodeOriginalTools(
  originalTools: EncodedOriginalTool[] | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  if (!originalTools) {
    return [];
  }

  const decodedTools: LanguageModelV4FunctionTool[] = [];

  for (const [index, tool] of originalTools.entries()) {
    if (!tool || typeof tool.name !== "string") {
      options?.onError?.("Invalid originalTools entry: missing tool name", {
        index,
        tool,
      });
      continue;
    }

    if (typeof tool.inputSchema !== "string") {
      options?.onError?.(
        "Invalid originalTools entry: inputSchema must be a string",
        {
          index,
          toolName: tool.name,
        }
      );
      continue;
    }

    try {
      decodedTools.push({
        type: "function",
        name: tool.name,
        inputSchema: JSON.parse(tool.inputSchema) as JSONSchema7,
      });
    } catch (error) {
      options?.onError?.(
        "Failed to decode originalTools input schema, using permissive fallback schema",
        {
          index,
          toolName: tool.name,
          inputSchema: tool.inputSchema,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      decodedTools.push({
        type: "function",
        name: tool.name,
        inputSchema: { type: "object" },
      });
    }
  }

  return decodedTools;
}

export function lookupCachedDecodedOriginalTools(
  originalTools: EncodedOriginalTool[] | undefined,
  options?: DecodeOriginalToolsOptions
): LanguageModelV4FunctionTool[] {
  if (originalTools) {
    const cached = encodedOriginalToolsCache.get(originalTools);
    if (
      cached &&
      cached.encodedEntries.length === originalTools.length &&
      cached.encodedEntries.every(
        (snapshot, index) =>
          snapshot.entry === originalTools[index] &&
          snapshot.name === originalTools[index]?.name &&
          snapshot.inputSchema === originalTools[index]?.inputSchema
      )
    ) {
      return cached.decodedTools;
    }
  }
  return decodeOriginalTools(originalTools, options);
}
