import type {
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCallPart,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import type { ResolvedProtocolToolCall } from "../protocols/protocol-interface";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "./protocol-utils";

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
}

export function getDebugLevel(): DebugLevel {
  const envVal =
    typeof process !== "undefined" && process.env
      ? process.env.DEBUG_PARSER_MW
      : undefined;
  switch (envVal) {
    case undefined:
    case "":
    case "off":
    case "0":
    case "false":
    case "no":
      return "off";
    case "stream":
    case "1":
    case "true":
    case "yes":
      return "stream";
    case "parse":
    case "2":
      return "parse";
    default:
      break;
  }
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

type ProtocolError = Extract<ResolvedProtocolToolCall, { ok: false }>["error"];

function safeStringify(value: ProtocolError): string {
  try {
    return `\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
  } catch {
    return String(value);
  }
}

function safeDebugText(value: ProtocolError): string {
  return safeToolCallMetadataText(safeStringify(value));
}

function formatSanitizedError(error: RxmlValue | Error): string {
  if (typeof error === "string") {
    return `\n${error}`;
  }
  if (error instanceof Error) {
    const stack = error.stack ? `\n${error.stack}` : "";
    return `\n${error.name}: ${error.message}${stack}`;
  }
  return safeStringify(error);
}

function formatError(error: ProtocolError): string {
  if (
    typeof error === "object" &&
    error !== null &&
    !(error instanceof Error)
  ) {
    return safeToolCallMetadataText(safeStringify(error));
  }
  const normalizedInput =
    error instanceof Error ? error : new Error(String(error));
  return formatSanitizedError(safeToolCallMetadataError(normalizedInput));
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
  error?: ProtocolError;
}) {
  if (getDebugLevel() !== "parse") {
    return;
  }

  const label = cBgBlue(`[${phase}]`);
  console.log(cGray("[debug:mw:fail]"), label, cYellow(reason));

  if (snippet) {
    const formatted = truncateSnippet(safeDebugText(snippet));
    console.log(cGray("[debug:mw:fail:snippet]"), formatted);
  }

  if (error) {
    console.log(cGray("[debug:mw:fail:error]"), cCyan(formatError(error)));
  }
}

export function logRawChunk(part: LanguageModelV4StreamPart | string) {
  // Raw provider stream/generate output
  console.log(cGray("[debug:mw:raw]"), cYellow(safeDebugText(part)));
}

export function logParsedChunk(
  part: LanguageModelV4Content | LanguageModelV4StreamPart
) {
  // Normalized middleware output
  console.log(cGray("[debug:mw:out]"), cCyan(safeDebugText(part)));
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
  return {
    inverse: cInverse,
    underline: cUnderline,
    bold: cBold,
    bg: cBgGreen,
  }[style];
}

function renderHighlightedText(
  originalText: string,
  highlight: (text: string) => string
) {
  return originalText
    .split(LINE_SPLIT_REGEX)
    .map((line) => (line.length ? highlight(line) : line))
    .join("\n");
}

export function logParsedSummary({
  toolCalls,
  originalText,
}: {
  toolCalls: LanguageModelV4ToolCallPart[];
  originalText: string;
}) {
  if (originalText) {
    const style = getHighlightStyle();
    const highlight = getHighlightFunction(style);
    const rendered = renderHighlightedText(
      safeToolCallMetadataText(originalText),
      highlight
    );

    console.log(cGray("[debug:mw:origin]"), `\n${rendered}`);
  }

  if (toolCalls.length > 0) {
    const styledSummary = safeDebugText(toolCalls)
      .split(LINE_SPLIT_REGEX)
      .map((line) => (line.length ? cBgBlue(line) : line))
      .join("\n");
    console.log(cGray("[debug:mw:summary]"), styledSummary);
  }
}
