import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { escapeRegExp } from "../utils/regex";

const QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE =
  /<\s*(parameter|param|argument|arg)(?:\s*=\s*["']?(?:__proto__|constructor|prototype)(?=["'\s/>]|$)["']?|\b(?=[^>]*\bname\s*=\s*["']\s*(?:__proto__|constructor|prototype)\s*["']))[^>]*>/gi;
const XML_SELF_CLOSING_TAG_RE = /\/\s*>$/;

interface SensitiveStandaloneParameterSpan {
  readonly endIndex: number;
  readonly startIndex: number;
  readonly text: string;
}

interface SensitiveStandaloneParameterDropOptions {
  readonly emitText: (text: string) => void;
  readonly onSensitiveText: (text: string) => void;
  readonly text: string;
}

function isSelfClosingXmlTag(tag: string): boolean {
  return XML_SELF_CLOSING_TAG_RE.test(tag);
}

function collectStandaloneSensitiveParameterSpans(
  text: string
): readonly SensitiveStandaloneParameterSpan[] {
  const spans: SensitiveStandaloneParameterSpan[] = [];
  QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE.lastIndex = 0;
  let match = QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE.exec(text);
  while (match) {
    const startIndex = match.index;
    const openTag = match[0] ?? "";
    const tagName = match[1] ?? "";
    const openEnd = startIndex + openTag.length;
    let endIndex = openEnd;
    if (!isSelfClosingXmlTag(openTag)) {
      const closePattern = new RegExp(
        `<\\s*\\/\\s*${escapeRegExp(tagName)}\\s*>`,
        "i"
      );
      const closeMatch = closePattern.exec(text.slice(openEnd));
      if (!closeMatch) {
        match = QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE.exec(text);
        continue;
      }
      endIndex = openEnd + (closeMatch.index ?? 0) + closeMatch[0].length;
    }
    spans.push({
      startIndex,
      endIndex,
      text: text.slice(startIndex, endIndex),
    });
    QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE.lastIndex = endIndex;
    match = QWEN_STANDALONE_SENSITIVE_PARAM_OPEN_RE.exec(text);
  }
  return spans;
}

export function emitTextWithSensitiveStandaloneParamDrops(
  options: SensitiveStandaloneParameterDropOptions
): boolean {
  const spans = collectStandaloneSensitiveParameterSpans(options.text);
  if (spans.length === 0) {
    return false;
  }

  let cursor = 0;
  const emitSafeText = (segment: string) => {
    if (segment.length === 0) {
      return;
    }
    if (toolCallTextHasPrototypeSensitiveKey(segment)) {
      options.onSensitiveText(segment);
      return;
    }
    options.emitText(segment);
  };

  for (const span of spans) {
    emitSafeText(options.text.slice(cursor, span.startIndex));
    options.onSensitiveText(span.text);
    cursor = span.endIndex;
  }
  emitSafeText(options.text.slice(cursor));
  return true;
}
