const WHITESPACE_RE = /\s/u;

export interface MarkdownCodeContext {
  activeContentHasNonWhitespace: boolean;
  delimiterLength: number;
  pendingBackticks: number;
  trailingBackslashes: number;
}

export function createMarkdownCodeContext(): MarkdownCodeContext {
  return {
    activeContentHasNonWhitespace: false,
    delimiterLength: 0,
    pendingBackticks: 0,
    trailingBackslashes: 0,
  };
}

function commitPendingBackticks(context: MarkdownCodeContext): void {
  if (context.pendingBackticks === 0) {
    return;
  }
  if (context.delimiterLength === 0) {
    context.delimiterLength = context.pendingBackticks;
    context.activeContentHasNonWhitespace = false;
  } else if (context.pendingBackticks === context.delimiterLength) {
    context.delimiterLength = 0;
    context.activeContentHasNonWhitespace = false;
  }
  context.pendingBackticks = 0;
}

/**
 * Track balanced Markdown backtick spans across arbitrary text chunks.
 * Different-length runs inside a span remain literal, matching the delimiter
 * rule needed to distinguish an opening code span from a just-closed one.
 */
export function consumeMarkdownCodeText(
  context: MarkdownCodeContext,
  text: string
): void {
  for (const character of text) {
    if (character === "`") {
      if (context.pendingBackticks > 0) {
        context.pendingBackticks += 1;
      } else if (context.trailingBackslashes % 2 === 0) {
        context.pendingBackticks = 1;
      }
      context.trailingBackslashes = 0;
      continue;
    }

    commitPendingBackticks(context);
    if (context.delimiterLength > 0 && !WHITESPACE_RE.test(character)) {
      context.activeContentHasNonWhitespace = true;
    }
    if (character === "\\") {
      context.trailingBackslashes += 1;
    } else {
      context.trailingBackslashes = 0;
    }
  }
}

/**
 * Suppress only a marker that begins directly inside a code delimiter (aside
 * from whitespace). Unbalanced prose backticks must not swallow a later,
 * otherwise valid tool call.
 */
export function markdownCodeContextSuppressesToolCall(
  context: MarkdownCodeContext
): boolean {
  commitPendingBackticks(context);
  return context.delimiterLength > 0 && !context.activeContentHasNonWhitespace;
}
