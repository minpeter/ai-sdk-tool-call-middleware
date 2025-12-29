export type DebugLevel = "off" | "stream" | "parse";

const LINE_SPLIT_REGEX = /\r?\n/;

function normalizeBooleanString(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return;
}

export function getDebugLevel(): DebugLevel {
  const envVal =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.DEBUG_PARSER_MW) ||
    "off";
  const envLower = String(envVal).toLowerCase();
  if (envLower === "stream" || envLower === "parse" || envLower === "off") {
    return envLower as DebugLevel;
  }
  const boolEnv = normalizeBooleanString(envLower);
  if (boolEnv === true) {
    return "stream";
  }
  if (envLower === "2") {
    return "parse";
  }
  return "off";
}

function color(code: number) {
  return (text: string) => `\u001b[${code}m${text}\u001b[0m`;
}

// ANSI color codes
const ANSI_GRAY = 90;
const ANSI_YELLOW = 33;
const ANSI_CYAN = 36;
const ANSI_BG_BLUE = 44;
const ANSI_BG_GREEN = 42;
const ANSI_INVERSE = 7;
const ANSI_UNDERLINE = 4;
const ANSI_BOLD = 1;

const cGray = color(ANSI_GRAY);
const cYellow = color(ANSI_YELLOW);
const cCyan = color(ANSI_CYAN);
const cBgBlue = color(ANSI_BG_BLUE);
const cBgGreen = color(ANSI_BG_GREEN);
const cInverse = color(ANSI_INVERSE);
const cUnderline = color(ANSI_UNDERLINE);
const cBold = color(ANSI_BOLD);

const MAX_SNIPPET_LENGTH = 800;

function safeStringify(value: unknown): string {
  try {
    return `\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack ? `\n${error.stack}` : "";
    return `\n${error.name}: ${error.message}${stack}`;
  }
  return safeStringify(error);
}

function truncateSnippet(snippet: string): string {
  if (snippet.length <= MAX_SNIPPET_LENGTH) {
    return snippet;
  }
  return `${snippet.slice(0, MAX_SNIPPET_LENGTH)}\n…[truncated ${snippet.length - MAX_SNIPPET_LENGTH} chars]`;
}

export function logParseFailure({
  phase,
  reason,
  snippet,
  error,
}: {
  phase: "generated-text" | "stream" | string;
  reason: string;
  snippet?: string;
  error?: unknown;
}) {
  if (getDebugLevel() !== "parse") {
    return;
  }

  const label = cBgBlue(`[${phase}]`);
  console.log(cGray("[debug:mw:fail]"), label, cYellow(reason));

  if (snippet) {
    const formatted = truncateSnippet(snippet);
    console.log(cGray("[debug:mw:fail:snippet]"), formatted);
  }

  if (error) {
    console.log(cGray("[debug:mw:fail:error]"), cCyan(formatError(error)));
  }
}

export function logRawChunk(part: unknown) {
  // Raw provider stream/generate output
  console.log(cGray("[debug:mw:raw]"), cYellow(safeStringify(part)));
}

export function logParsedChunk(part: unknown) {
  // Normalized middleware output
  console.log(cGray("[debug:mw:out]"), cCyan(safeStringify(part)));
}

function getHighlightStyle(): "inverse" | "underline" | "bold" | "bg" {
  const envVal =
    (typeof process !== "undefined" &&
      process.env &&
      process.env.DEBUG_PARSER_MW_STYLE) ||
    "bg";

  const normalized = String(envVal).trim().toLowerCase();
  if (normalized === "inverse" || normalized === "invert") {
    return "inverse" as const;
  }
  if (normalized === "underline" || normalized === "ul") {
    return "underline" as const;
  }
  if (normalized === "bold") {
    return "bold" as const;
  }
  if (normalized === "bg" || normalized === "background") {
    return "bg" as const;
  }
  const asBool = normalizeBooleanString(normalized);
  if (asBool === true) {
    return "bg" as const;
  }
  return "bg" as const; // default: background highlight
}

function getHighlightFunction(style: "inverse" | "underline" | "bold" | "bg") {
  if (style === "inverse") {
    return cInverse;
  }
  if (style === "underline") {
    return cUnderline;
  }
  if (style === "bold") {
    return cBold;
  }
  if (style === "bg") {
    return cBgGreen;
  }
  return cYellow;
}

function renderHighlightedText(
  originalText: string,
  style: "inverse" | "underline" | "bold" | "bg",
  highlight: (text: string) => string
) {
  if (
    style === "bg" ||
    style === "inverse" ||
    style === "underline" ||
    style === "bold"
  ) {
    return originalText
      .split(LINE_SPLIT_REGEX)
      .map((line) => (line.length ? highlight(line) : line))
      .join("\n");
  }
  return highlight(originalText);
}

export function logParsedSummary({
  toolCalls,
  originalText,
}: {
  toolCalls: unknown[];
  originalText: string;
}) {
  if (originalText) {
    const style = getHighlightStyle();
    const highlight = getHighlightFunction(style);
    const rendered = renderHighlightedText(originalText, style, highlight);

    console.log(cGray("[debug:mw:origin]"), `\n${rendered}`);
  }

  if (toolCalls.length > 0) {
    const styledSummary = safeStringify(toolCalls)
      .split(LINE_SPLIT_REGEX)
      .map((line) => (line.length ? cBgBlue(line) : line))
      .join("\n");
    console.log(cGray("[debug:mw:summary]"), styledSummary);
  }
}
