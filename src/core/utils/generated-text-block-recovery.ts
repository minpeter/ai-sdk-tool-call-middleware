import {
  isJSONObject,
  type JSONObject,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { containsPrototypeSensitiveKey } from "./generated-text-json-candidates";
import {
  findQwenCallCloseTag,
  isSelfClosingTag,
  QWEN_CALL_BLOCK_OPEN_REGEX,
  readFunctionBlockParams,
  readQwenCallToolName,
} from "./generated-text-qwen-markup";
import {
  type DroppedSensitiveSpan,
  isLikelyArgumentsShapeForTool,
  type RecoveredCallSpan,
  readToolArgsField,
  readToolNameField,
  toToolCallCandidate,
} from "./generated-text-tool-candidates";
import { toolCallTextHasPrototypeSensitiveKey } from "./prototype-sensitive-keys";

interface QwenFunctionBlock {
  readonly body: string;
  readonly endIndex: number;
  readonly openTag: string;
  readonly startIndex: number;
}

function* readQwenFunctionBlocks(text: string): Generator<QwenFunctionBlock> {
  const opens = [...text.matchAll(QWEN_CALL_BLOCK_OPEN_REGEX)];
  for (let index = 0; index < opens.length; index += 1) {
    const open = opens[index];
    const openTag = open[0] ?? "";
    const bodyStart = open.index + openTag.length;
    const nextOpenIndex = opens[index + 1]?.index ?? text.length;
    const selfClosing = isSelfClosingTag(openTag);
    const close = selfClosing
      ? null
      : findQwenCallCloseTag(
          text,
          bodyStart,
          (open[1] ?? "").toLowerCase(),
          nextOpenIndex
        );
    yield {
      body: selfClosing
        ? ""
        : text.slice(bodyStart, close?.start ?? nextOpenIndex),
      endIndex: selfClosing
        ? open.index + openTag.length
        : (close?.end ?? nextOpenIndex),
      openTag,
      startIndex: open.index,
    };
  }
}

export function extractFunctionBlockCallSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoveredCallSpan[] {
  const spans: RecoveredCallSpan[] = [];
  for (const block of readQwenFunctionBlocks(text)) {
    const toolName = readQwenCallToolName(block.openTag, block.body);
    if (!(toolName && tools.some((tool) => tool.name === toolName))) {
      continue;
    }

    const params = readFunctionBlockParams(block.body);
    if (!isJSONObject(params)) {
      continue;
    }

    const payload = toToolCallCandidate(toolName, params, tools);
    if (payload) {
      spans.push({
        startIndex: block.startIndex,
        endIndex: block.endIndex,
        payload,
      });
    }
  }

  return spans;
}

export function extractSensitiveFunctionBlockDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): DroppedSensitiveSpan[] {
  if (!toolCallTextHasPrototypeSensitiveKey(text)) {
    return [];
  }

  const spans: DroppedSensitiveSpan[] = [];
  for (const block of readQwenFunctionBlocks(text)) {
    const rawBlock = text.slice(block.startIndex, block.endIndex);
    const toolName = readQwenCallToolName(block.openTag, block.body);
    if (
      toolName &&
      tools.some((tool) => tool.name === toolName) &&
      toolCallTextHasPrototypeSensitiveKey(rawBlock)
    ) {
      spans.push({
        startIndex: block.startIndex,
        endIndex: block.endIndex,
        dropReason: "prototype-sensitive-tool-candidate",
      });
    }
  }
  return spans;
}

const TOOL_CALL_BLOCK_OPEN_REGEX = /<tool_call\s*>/gi;
const CLOSING_TAG_REGEX = /<\/\s*([A-Za-z_][\w.:-]*)\s*>/;

function parseYamlBlockMapping(
  body: string,
  rejectSensitive: boolean
): JSONObject | null {
  try {
    const parsed = YAML.parse(body);
    if (!isJSONObject(parsed)) {
      return null;
    }
    return rejectSensitive && containsPrototypeSensitiveKey(parsed)
      ? null
      : parsed;
  } catch {
    return null;
  }
}

function resolveYamlBlockPayload(
  mapping: JSONObject,
  closeTagName: string | null,
  tools: LanguageModelV4FunctionTool[]
) {
  const envelopeName = readToolNameField(mapping);
  if (envelopeName && tools.some((tool) => tool.name === envelopeName)) {
    const rawArgs = readToolArgsField(mapping);
    const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (isJSONObject(args) && !containsPrototypeSensitiveKey(args)) {
      return toToolCallCandidate(envelopeName, args, tools);
    }
    return null;
  }

  if (closeTagName) {
    const candidates = [closeTagName, closeTagName.split(":").at(-1) ?? ""];
    const matched = candidates.find((name) =>
      tools.some((tool) => tool.name === name)
    );
    if (matched) {
      return toToolCallCandidate(matched, mapping, tools);
    }
  }

  if (tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0])) {
    return toToolCallCandidate(tools[0].name, mapping, tools);
  }
  return null;
}

interface YamlBlock {
  readonly body: string;
  readonly closeTagName: string | null;
  readonly endIndex: number;
  readonly startIndex: number;
}

function readYamlBlocks(text: string): YamlBlock[] {
  const blocks: YamlBlock[] = [];
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
    blocks.push({ body, closeTagName, endIndex, startIndex: match.index });
    match = nextOpen;
  }
  return blocks;
}

export function extractYamlToolCallBlockSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): RecoveredCallSpan[] {
  const spans: RecoveredCallSpan[] = [];
  for (const block of readYamlBlocks(text)) {
    const mapping = parseYamlBlockMapping(block.body, true);
    const payload = mapping
      ? resolveYamlBlockPayload(mapping, block.closeTagName, tools)
      : null;
    if (payload) {
      spans.push({
        startIndex: block.startIndex,
        endIndex: block.endIndex,
        payload,
      });
    }
  }
  return spans;
}

export function extractSensitiveYamlToolCallBlockDropSpans(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): DroppedSensitiveSpan[] {
  const spans: DroppedSensitiveSpan[] = [];
  for (const block of readYamlBlocks(text)) {
    const mapping = parseYamlBlockMapping(block.body, false);
    if (!(mapping && containsPrototypeSensitiveKey(mapping))) {
      continue;
    }
    const envelopeName = readToolNameField(mapping);
    const closeName = block.closeTagName?.split(":").at(-1) ?? "";
    const knownEnvelope =
      envelopeName !== null && tools.some((tool) => tool.name === envelopeName);
    const knownClose =
      closeName.length > 0 && tools.some((tool) => tool.name === closeName);
    const likelySingleToolArgs =
      tools.length === 1 && isLikelyArgumentsShapeForTool(mapping, tools[0]);
    if (knownEnvelope || knownClose || likelySingleToolArgs) {
      spans.push({
        startIndex: block.startIndex,
        endIndex: block.endIndex,
        dropReason: "prototype-sensitive-tool-candidate",
      });
    }
  }
  return spans;
}
