import { findQuantifierEnd } from "./safe-pattern-atoms";

interface RegexGroupState {
  hasAlternation: boolean;
  hasQuantifier: boolean;
}

interface RegexRiskScanState {
  escaped: boolean;
  readonly groups: RegexGroupState[];
  inCharClass: boolean;
}

function groupPrefixEnd(pattern: string, groupStart: number): number | null {
  if (pattern.charAt(groupStart + 1) !== "?") {
    return null;
  }
  const prefix = pattern.charAt(groupStart + 2);
  if (prefix === ":" || prefix === "=" || prefix === "!") {
    return groupStart + 2;
  }
  if (prefix !== "<") {
    return null;
  }
  const lookbehindPrefix = pattern.charAt(groupStart + 3);
  if (lookbehindPrefix === "=" || lookbehindPrefix === "!") {
    return groupStart + 3;
  }
  const nameEnd = pattern.indexOf(">", groupStart + 3);
  return nameEnd === -1 ? null : nameEnd;
}

function consumeEscapeOrClassState(
  state: RegexRiskScanState,
  char: string
): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\") {
    state.escaped = true;
    return true;
  }
  if (char === "[" && !state.inCharClass) {
    state.inCharClass = true;
    return true;
  }
  if (char === "]" && state.inCharClass) {
    state.inCharClass = false;
    return true;
  }
  return state.inCharClass;
}

function markParentGroupQuantified(groups: RegexGroupState[]): void {
  const parentGroup = groups.at(-1);
  if (parentGroup) {
    parentGroup.hasQuantifier = true;
  }
}

function closeGroup(
  pattern: string,
  index: number,
  groups: RegexGroupState[]
): { readonly nextIndex: number; readonly risk: boolean } {
  const group = groups.pop();
  const end = findQuantifierEnd(pattern, index + 1);
  if (!(group && end != null)) {
    return { nextIndex: index, risk: false };
  }
  if (group.hasAlternation || group.hasQuantifier) {
    return { nextIndex: index, risk: true };
  }
  markParentGroupQuantified(groups);
  return { nextIndex: end, risk: false };
}

export function hasNestedQuantifierRisk(pattern: string): boolean {
  const state: RegexRiskScanState = {
    escaped: false,
    groups: [],
    inCharClass: false,
  };

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (consumeEscapeOrClassState(state, char)) {
      continue;
    }
    if (char === "(") {
      state.groups.push({ hasAlternation: false, hasQuantifier: false });
      index = groupPrefixEnd(pattern, index) ?? index;
      continue;
    }
    if (char === ")" && state.groups.length > 0) {
      const closed = closeGroup(pattern, index, state.groups);
      if (closed.risk) {
        return true;
      }
      index = closed.nextIndex;
      continue;
    }
    const currentGroup = state.groups.at(-1);
    if (char === "|" && currentGroup) {
      currentGroup.hasAlternation = true;
      continue;
    }
    const end = findQuantifierEnd(pattern, index);
    if (end != null) {
      markParentGroupQuantified(state.groups);
      index = end;
    }
  }
  return false;
}
