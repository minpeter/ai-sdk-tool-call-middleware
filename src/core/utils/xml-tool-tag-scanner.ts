import { escapeRegExp } from "./regex";

export interface EarliestToolTag {
  index: number;
  name: string;
  selfClosing: boolean;
  tagLength: number;
}

export interface ToolTagMatch {
  isSelfClosing: boolean;
  tagLength: number;
  tagStart: number;
}

const selfClosingTagCache = new Map<string, RegExp>();

export function getSelfClosingTagPattern(toolName: string): RegExp {
  let pattern = selfClosingTagCache.get(toolName);
  if (!pattern) {
    pattern = new RegExp(`<\\s*${escapeRegExp(toolName)}\\s*/>`, "g");
    selfClosingTagCache.set(toolName, pattern);
  }
  return pattern;
}

export function findSelfClosingTag(
  text: string,
  toolName: string,
  fromIndex: number
): { index: number; length: number } | null {
  const pattern = getSelfClosingTagPattern(toolName);
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  return { index: match.index, length: match[0].length };
}

export function findNextToolTag(
  text: string,
  searchIndex: number,
  toolName: string
): ToolTagMatch | null {
  const startTag = `<${toolName}>`;
  const openIdx = text.indexOf(startTag, searchIndex);
  const selfMatch = findSelfClosingTag(text, toolName, searchIndex);
  const selfIdx = selfMatch?.index ?? -1;

  if (openIdx === -1 && selfIdx === -1) {
    return null;
  }

  const isSelfClosing = selfIdx !== -1 && (openIdx === -1 || selfIdx < openIdx);
  return {
    tagStart: isSelfClosing ? selfIdx : openIdx,
    isSelfClosing,
    tagLength: isSelfClosing ? (selfMatch?.length ?? 0) : startTag.length,
  };
}

export function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): EarliestToolTag {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;
  let bestTagLength = 0;

  for (const name of toolNames) {
    const openTag = `<${name}>`;
    const idxOpen = buffer.indexOf(openTag);
    const selfMatch = findSelfClosingTag(buffer, name, 0);
    const idxSelf = selfMatch?.index ?? -1;

    if (idxOpen !== -1 && (bestIndex === -1 || idxOpen < bestIndex)) {
      bestIndex = idxOpen;
      bestName = name;
      bestSelfClosing = false;
      bestTagLength = openTag.length;
    }

    if (idxSelf !== -1 && (bestIndex === -1 || idxSelf < bestIndex)) {
      bestIndex = idxSelf;
      bestName = name;
      bestSelfClosing = true;
      bestTagLength = selfMatch?.length ?? 0;
    }
  }

  return {
    index: bestIndex,
    name: bestName,
    selfClosing: bestSelfClosing,
    tagLength: bestTagLength,
  };
}
