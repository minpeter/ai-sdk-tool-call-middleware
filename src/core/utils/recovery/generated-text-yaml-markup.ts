import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import YAML from "yaml";
import {
  containsPrototypeSensitiveKey,
  isRecord,
} from "./generated-text-json-candidates";
import {
  type DroppedSensitiveSpan,
  isLikelyArgumentsShapeForTool,
  type RecoveredCallSpan,
  readToolArgsField,
  readToolNameField,
  type ToolCallCandidate,
  toToolCallCandidate,
} from "./recovery-types";

const TOOL_CALL_BLOCK_OPEN_REGEX = /<tool_call\s*>/gi;
// Colon included for namespaced garbage closes like `</functions:get_weather>`.
const CLOSING_TAG_REGEX = /<\/\s*([A-Za-z_][\w.:-]*)\s*>/;

function parseYamlBlockMapping(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || containsPrototypeSensitiveKey(parsed)) {
    return null;
  }
  return parsed;
}

function parseYamlBlockMappingUnsafe(
  body: string
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function resolveYamlBlockPayload(
  mapping: Record<string, unknown>,
  closeTagName: string | null,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  // Envelope form: `name: get_weather\narguments:\n  city: Seoul`.
  const envelopeName = readToolNameField(mapping);
  if (envelopeName && tools.some((tool) => tool.name === envelopeName)) {
    const rawArgs = readToolArgsField(mapping);
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (isRecord(args) && !containsPrototypeSensitiveKey(args)) {
      return toToolCallCandidate(envelopeName, args, tools);
    }
    return null;
  }

  // Bare-args form closed by a tag carrying the tool name:
  // `<tool_call>\ncity: Seoul\n</get_weather>` (possibly namespaced, e.g.
  // `</functions:get_weather>`).
  if (closeTagName) {
    const candidates = [closeTagName, closeTagName.split(":").at(-1) ?? ""];
    const matched = candidates.find((name) =>
      tools.some((tool) => tool.name === name)
    );
    if (matched) {
      return toToolCallCandidate(matched, mapping, tools);
    }
  }

  // Bare-args form with a single tool whose schema matches.
  if (tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0])) {
    return toToolCallCandidate(tools[0].name, mapping, tools);
  }

  return null;
}

/**
 * Recover `<tool_call>` blocks whose body is a YAML mapping instead of JSON
 * (observed live on IBM Granite 4.0, which emits this shape under every
 * prompt format, closing with an arbitrary tag such as `</weather>` or the
 * tool name).
 */
export function extractYamlToolCallBlockSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoveredCallSpan[] {
  const spans: RecoveredCallSpan[] = [];

  TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = bodyStart;
    const nextOpen = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
    const blockEnd = nextOpen == null ? text.length : nextOpen.index;

    let body = text.slice(bodyStart, blockEnd);
    let endIndex = blockEnd;
    let closeTagName: string | null = null;

    // The close tag is unreliable in this shape — the first closing tag in
    // the block (e.g. `</weather>`, `</tool_call>`, `</get_weather>`)
    // terminates the body and may carry the tool name.
    const closeMatch = CLOSING_TAG_REGEX.exec(body);
    if (closeMatch) {
      closeTagName = closeMatch[1] ?? null;
      endIndex = bodyStart + closeMatch.index + closeMatch[0].length;
      body = body.slice(0, closeMatch.index);
    }

    const mapping = parseYamlBlockMapping(body);
    const payload = mapping
      ? resolveYamlBlockPayload(mapping, closeTagName, tools)
      : null;
    if (payload) {
      spans.push({ startIndex: match.index, endIndex, payload });
    }

    match = nextOpen;
  }

  return spans;
}

export function extractSensitiveYamlToolCallBlockDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): DroppedSensitiveSpan[] {
  const spans: DroppedSensitiveSpan[] = [];

  TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = bodyStart;
    const nextOpen = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
    const blockEnd = nextOpen == null ? text.length : nextOpen.index;

    let body = text.slice(bodyStart, blockEnd);
    let endIndex = blockEnd;
    let closeTagName: string | null = null;

    const closeMatch = CLOSING_TAG_REGEX.exec(body);
    if (closeMatch) {
      closeTagName = closeMatch[1] ?? null;
      endIndex = bodyStart + closeMatch.index + closeMatch[0].length;
      body = body.slice(0, closeMatch.index);
    }

    const mapping = parseYamlBlockMappingUnsafe(body);
    if (mapping && containsPrototypeSensitiveKey(mapping)) {
      const envelopeName = readToolNameField(mapping);
      const closeName = closeTagName?.split(":").at(-1) ?? "";
      const knownEnvelope =
        envelopeName !== null &&
        tools.some((tool) => tool.name === envelopeName);
      const knownClose =
        closeName.length > 0 && tools.some((tool) => tool.name === closeName);
      const likelySingleToolArgs =
        tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0]);
      if (knownEnvelope || knownClose || likelySingleToolArgs) {
        spans.push({
          startIndex: match.index,
          endIndex,
          dropReason: "prototype-sensitive-tool-candidate",
        });
      }
    }

    match = nextOpen;
  }

  return spans;
}
