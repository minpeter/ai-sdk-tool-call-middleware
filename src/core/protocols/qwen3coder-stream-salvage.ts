import type { JSONObject, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import { extractQwen3CoderToolNameFromMarkup } from "./qwen3coder-call-parsing";
import {
  CALL_BLOCK_RE,
  normalizeToolCallInnerOpenVariants,
  SALVAGE_MARKUP_ONLY_TEXT_REGEX,
  TOOL_CALL_CLOSE_RE,
  TOOL_CALL_OPEN_RE,
} from "./qwen3coder-call-syntax";
import { getAttributeValue } from "./qwen3coder-param-tag-parsing";

interface ParsedQwenToolCall {
  args: JSONObject;
  toolName: string;
}

interface SerializedQwenToolCall {
  input: string;
  toolCallId: string;
  toolName: string;
}

const XML_TAG_RE = /<\s*\/?\s*[A-Za-z_][\w.:-]*\b[^>]*>/g;
const XML_TAG_NAME_START_RE = /[A-Za-z_]/;
const XML_TAG_NAME_END_RE = /[^\w.:-]/;
const XML_TAG_CLOSING_RE = /^<\s*\//;
const XML_VALUE_TAG_NAMES = new Set(["parameter", "param", "argument", "arg"]);

interface ToolCallBody {
  body: string;
  outerOpenTag: string;
}

function extractToolCallBody(markup: string): ToolCallBody | null {
  const open = TOOL_CALL_OPEN_RE.exec(markup);
  if (!open) {
    return null;
  }
  const bodyStart = open.index + open[0].length;
  const rest = markup.slice(bodyStart);
  const close = TOOL_CALL_CLOSE_RE.exec(rest);
  const bodyEnd =
    close?.index == null ? markup.length : bodyStart + close.index;
  return {
    body: markup.slice(bodyStart, bodyEnd),
    outerOpenTag: open[0],
  };
}

function isValueTagName(
  tagName: string,
  tools: LanguageModelV4FunctionTool[],
  toolName: string | null
): boolean {
  const normalized = tagName.toLowerCase();
  if (XML_VALUE_TAG_NAMES.has(normalized)) {
    return true;
  }
  if (!toolName) {
    return false;
  }
  const tool = tools.find((candidate) => candidate.name === toolName);
  return Object.keys(tool?.inputSchema.properties ?? {}).some(
    (property) => property.toLowerCase() === normalized
  );
}

function lastXmlTag(body: string): { closing: boolean; name: string } | null {
  let last: { closing: boolean; name: string } | null = null;
  XML_TAG_RE.lastIndex = 0;
  for (const [tag] of body.matchAll(XML_TAG_RE)) {
    const nameStart = tag.search(XML_TAG_NAME_START_RE);
    const nameEnd =
      nameStart + tag.slice(nameStart).search(XML_TAG_NAME_END_RE);
    last = {
      closing: XML_TAG_CLOSING_RE.test(tag),
      name: tag.slice(nameStart, nameEnd),
    };
  }
  return last;
}

export function hasProseOutsideXmlCalls(
  markup: string,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const extracted = extractToolCallBody(markup);
  if (extracted === null) {
    return false;
  }
  const normalizedBody = normalizeToolCallInnerOpenVariants(
    extracted.body,
    tools
  );
  const outerNameAttr = getAttributeValue(extracted.outerOpenTag, "name");
  const toolName =
    extractQwen3CoderToolNameFromMarkup(normalizedBody) ??
    outerNameAttr ??
    null;

  const firstTagStart = normalizedBody.indexOf("<");
  if (firstTagStart === -1) {
    return normalizedBody.trim().length > 0;
  }
  if (
    firstTagStart > 0 &&
    !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(normalizedBody.slice(0, firstTagStart))
  ) {
    return true;
  }

  let matched = false;
  let cursor = 0;
  CALL_BLOCK_RE.lastIndex = 0;
  for (const match of normalizedBody.matchAll(CALL_BLOCK_RE)) {
    matched = true;
    const start = match.index;
    const before = normalizedBody.slice(cursor, start);
    if (!SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(before)) {
      return true;
    }
    cursor = start + match[0].length;
  }
  if (
    matched &&
    !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(normalizedBody.slice(cursor))
  ) {
    return true;
  }

  const lastTagEnd = normalizedBody.lastIndexOf(">");
  if (lastTagEnd === -1) {
    return false;
  }
  const trailing = normalizedBody.slice(lastTagEnd + 1);
  if (SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(trailing)) {
    return false;
  }
  const lastTag = lastXmlTag(normalizedBody);
  return (
    lastTag === null ||
    lastTag.closing ||
    !isValueTagName(lastTag.name, tools, toolName)
  );
}

export function serializeQwenToolParserCalls(
  calls: ParsedQwenToolCall[],
  tools: LanguageModelV4FunctionTool[]
): SerializedQwenToolCall[] | null {
  const serializedCalls: SerializedQwenToolCall[] = [];
  for (const call of calls) {
    try {
      serializedCalls.push({
        toolCallId: generateToolCallId(),
        toolName: call.toolName,
        input: stringifyToolInputWithSchema({
          tools,
          toolName: call.toolName,
          args: call.args,
        }),
      });
    } catch {
      return null;
    }
  }
  return serializedCalls;
}
