import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import YAML from "yaml";
import {
  containsPrototypeSensitiveKey,
  isRecord,
} from "./generated-text-json-candidates";
import {
  isLikelyArgumentsShapeForTool,
  type RecoverySpan,
  readToolArgsField,
  readToolNameField,
  type ToolCallCandidate,
  toToolCallCandidate,
} from "./recovery-types";

const TOOL_CALL_BLOCK_OPEN_REGEX = /<tool_call\s*>/gi;
// Colon included for namespaced garbage closes like `</functions:get_weather>`.
// Anchoring to column 0 avoids terminating on closing tags inside indented
// YAML block scalars (`content: |\n  </body>`) or quoted inline strings.
const LINE_START_CLOSING_TAG_REGEX =
  /(?:^|\r?\n)<\/\s*([A-Za-z_][\w.:-]*)\s*>/g;
const TRAILING_CLOSING_TAG_REGEX = /<\/\s*([A-Za-z_][\w.:-]*)\s*>\s*$/;

interface ParsedYamlBlock {
  closeTagName: string | null;
  endIndex: number;
  mapping: Record<string, unknown>;
}

function parseYamlRecord(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(body);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function parseYamlToolCallBlock(
  rawBlock: string,
  bodyStart: number
): ParsedYamlBlock | null {
  // 1. Prefer an unindented closing tag on its own line (Granite / XML wrapper
  //    shape). Trying each line-start close tag in order skips markup inside
  //    YAML values while preserving any trailing prose after the real close tag.
  for (const match of rawBlock.matchAll(LINE_START_CLOSING_TAG_REGEX)) {
    const tagStart = match.index + match[0].indexOf("</");
    const mapping = parseYamlRecord(rawBlock.slice(0, tagStart));
    if (mapping) {
      return {
        closeTagName: match[1] ?? null,
        endIndex: bodyStart + match.index + match[0].length,
        mapping,
      };
    }
  }

  // 2. Fallback for single-line blocks ending directly in a closing tag
  //    (e.g. `<tool_call>city: Seoul</get_weather>`).
  const trailingClose = TRAILING_CLOSING_TAG_REGEX.exec(rawBlock);
  if (trailingClose) {
    const mapping = parseYamlRecord(rawBlock.slice(0, trailingClose.index));
    if (mapping) {
      return {
        closeTagName: trailingClose[1] ?? null,
        endIndex: bodyStart + trailingClose.index + trailingClose[0].length,
        mapping,
      };
    }
  }

  // 3. Unclosed `<tool_call>` block whose entire body is a YAML mapping.
  const fullMapping = parseYamlRecord(rawBlock);
  if (fullMapping) {
    return {
      closeTagName: null,
      endIndex: bodyStart + rawBlock.length,
      mapping: fullMapping,
    };
  }

  return null;
}

function findMatchingCloseTagToolName(
  closeTagName: string | null,
  tools: LanguageModelV4FunctionTool[]
): string | undefined {
  if (!closeTagName) {
    return undefined;
  }
  const candidates = [closeTagName, closeTagName.split(":").at(-1) ?? ""];
  return candidates.find(
    (name) => name.length > 0 && tools.some((tool) => tool.name === name)
  );
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
  const matchedCloseTagTool = findMatchingCloseTagToolName(closeTagName, tools);
  if (matchedCloseTagTool) {
    return toToolCallCandidate(matchedCloseTagTool, mapping, tools);
  }

  // Bare-args form with a single tool whose schema matches.
  if (tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0])) {
    return toToolCallCandidate(tools[0].name, mapping, tools);
  }

  return null;
}

function isKnownSensitiveYamlCandidate(
  mapping: Record<string, unknown>,
  closeTagName: string | null,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const envelopeName = readToolNameField(mapping);
  const knownEnvelope =
    envelopeName !== null && tools.some((tool) => tool.name === envelopeName);
  const knownClose =
    findMatchingCloseTagToolName(closeTagName, tools) !== undefined;
  const likelySingleToolArgs =
    tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0]);
  return knownEnvelope || knownClose || likelySingleToolArgs;
}

/**
 * Recover `<tool_call>` blocks whose body is a YAML mapping instead of JSON
 * (observed live on IBM Granite 4.0, which emits this shape under every
 * prompt format, closing with an arbitrary tag such as `</weather>` or the
 * tool name), and emit drop spans for prototype-sensitive known-tool blocks
 * in a single pass.
 */
export function extractYamlToolCallSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoverySpan[] {
  const spans: RecoverySpan[] = [];

  TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = 0;
  let match = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
  while (match) {
    const bodyStart = match.index + match[0].length;
    TOOL_CALL_BLOCK_OPEN_REGEX.lastIndex = bodyStart;
    const nextOpen = TOOL_CALL_BLOCK_OPEN_REGEX.exec(text);
    const blockEnd = nextOpen == null ? text.length : nextOpen.index;

    const parsed = parseYamlToolCallBlock(
      text.slice(bodyStart, blockEnd),
      bodyStart
    );
    if (parsed) {
      if (containsPrototypeSensitiveKey(parsed.mapping)) {
        if (
          isKnownSensitiveYamlCandidate(
            parsed.mapping,
            parsed.closeTagName,
            tools
          )
        ) {
          spans.push({
            startIndex: match.index,
            endIndex: parsed.endIndex,
            dropReason: "prototype-sensitive-tool-candidate",
          });
        }
      } else {
        const payload = resolveYamlBlockPayload(
          parsed.mapping,
          parsed.closeTagName,
          tools
        );
        if (payload) {
          spans.push({
            startIndex: match.index,
            endIndex: parsed.endIndex,
            payload,
          });
        }
      }
    }

    match = nextOpen;
  }

  return spans;
}
