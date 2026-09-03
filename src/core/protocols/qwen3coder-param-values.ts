import { unescapeXml } from "../../rxml/utils/helpers";
import { escapeRegExp } from "../utils/regex";
import {
  CALL_SHORTHAND_VALUE_RE,
  isAsciiWhitespace,
  skipAsciiWhitespace,
} from "./qwen3coder-call-syntax";

export function findTagEndIndex(
  text: string,
  startIndex: number
): number | null {
  let quote: '"' | "'" | null = null;
  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return null;
}

export function parseShorthandValue(
  openTag: string,
  tagNameLower: string
): string | null {
  let i = 1;
  i = skipAsciiWhitespace(openTag, i);
  if (!openTag.toLowerCase().startsWith(tagNameLower, i)) {
    return null;
  }
  i += tagNameLower.length;
  i = skipAsciiWhitespace(openTag, i);
  if (openTag[i] !== "=") {
    return null;
  }
  i += 1;
  i = skipAsciiWhitespace(openTag, i);

  const quote = openTag[i] ?? "";
  if (quote === '"' || quote === "'") {
    const end = openTag.indexOf(quote, i + 1);
    if (end === -1) {
      return null;
    }
    return openTag.slice(i + 1, end);
  }

  const start = i;
  while (i < openTag.length) {
    const ch = openTag[i] ?? "";
    if (isAsciiWhitespace(ch) || ch === ">" || ch === "/") {
      break;
    }
    i += 1;
  }
  const value = openTag.slice(start, i);
  return value.length > 0 ? value : null;
}

export function parseQwen3CoderToolParserParamName(
  openTag: string,
  tagNameLower: string
): string | null {
  const shorthand = parseShorthandValue(openTag, tagNameLower);
  if (shorthand != null) {
    return unescapeXml(shorthand);
  }

  return getAttributeValue(openTag, "name");
}

const VALUE_ELEMENT_WRAPPER_RE = /^<value\s*>([\s\S]*)<\/value\s*>$/i;

export function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  // Some models wrap the value in a literal <value> element
  // (`<parameter=volume><value>0.8</value></parameter>`, observed live on
  // Llama 3.1 8B); unwrap exactly that shape.
  const valueWrapper = VALUE_ELEMENT_WRAPPER_RE.exec(out);
  if (valueWrapper) {
    out = (valueWrapper[1] ?? "").trim();
  }
  return unescapeXml(out);
}

export function getOpeningTag(xml: string): string | null {
  const gt = xml.indexOf(">");
  if (gt === -1) {
    return null;
  }
  return xml.slice(0, gt + 1);
}

const attrValueRegExpCache = new Map<string, RegExp>();

export function getAttributeValue(
  openTag: string,
  attrName: string
): string | null {
  let re = attrValueRegExpCache.get(attrName);
  if (!re) {
    // Since the regex has no 'g' flag, re.exec resets automatically — safe.
    re = new RegExp(
      `(?:^|[\\s<])${escapeRegExp(attrName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "i"
    );
    attrValueRegExpCache.set(attrName, re);
  }
  const match = re.exec(openTag);
  if (!match) {
    return null;
  }
  return unescapeXml(match[2] ?? "").trim();
}

export function getShorthandValue(openTag: string): string | null {
  const match = CALL_SHORTHAND_VALUE_RE.exec(openTag);
  if (!match) {
    return null;
  }
  const value = match[2] ?? match[3] ?? match[4];
  if (!value) {
    return null;
  }
  const normalized = unescapeXml(value).trim();
  return normalized.length > 0 ? normalized : null;
}
