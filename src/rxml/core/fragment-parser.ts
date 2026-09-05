import { RXMLParseError } from "../errors/types";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

function shouldRethrowParseError(
  error: Error,
  xmlString: string
): error is RXMLParseError {
  if (!(error instanceof RXMLParseError)) {
    return false;
  }
  const isSimple = xmlString.split("<").length < 6;
  return (
    (error.message.includes("Unexpected close tag") && isSimple) ||
    (error.message.includes("Unclosed tag") && isSimple)
  );
}

/**
 * Try to extract partial XML results from malformed XML
 */
function extractPartialXmlResults(
  xmlString: string,
  options: ParseOptions
): (RXMLNode | string)[] {
  const partialResults: (RXMLNode | string)[] = [];
  const xmlPattern = /<([a-zA-Z_][\w.-]*)[^>]*>.*?<\/\1>/gs;
  let match: RegExpExecArray | null = null;

  match = xmlPattern.exec(xmlString);
  while (match !== null) {
    try {
      const [elementXml] = match;
      const tokenizer = new XMLTokenizer(elementXml, options);
      const parsed = tokenizer.parseChildren();
      partialResults.push(...parsed);
    } catch {
      // Ignore parse errors for individual elements
    }
    match = xmlPattern.exec(xmlString);
  }

  return partialResults;
}

export function parseWithoutSchema(
  xmlString: string,
  options: ParseOptions = {}
): (RXMLNode | string)[] {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseChildren();
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    // Check if this is a specific type of error that should be re-thrown
    if (shouldRethrowParseError(normalizedError, xmlString)) {
      // Preserve the original error message and line/column information
      // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
      throw new RXMLParseError(
        normalizedError.message,
        normalizedError,
        normalizedError.line,
        normalizedError.column
      );
    }

    // For other types of malformed XML, try to be more tolerant and return partial results
    options.onError?.("Failed to parse XML without schema", {
      error: normalizedError,
    });

    // Try to extract any valid XML elements that we can parse
    try {
      const partialResults = extractPartialXmlResults(xmlString, options);
      if (partialResults.length > 0) {
        return partialResults;
      }
    } catch {
      // Fallback failed too
    }

    // Last resort: return the input as text content
    return [xmlString.trim()];
  }
}

/**
 * Parse a single XML node
 */
export function parseNode(
  xmlString: string,
  options: ParseOptions = {}
): RXMLNode {
  try {
    const tokenizer = new XMLTokenizer(xmlString, options);
    return tokenizer.parseNode();
  } catch (error) {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    // biome-ignore lint/style/useErrorCause: RXML errors carry the original error via their positional cause parameter.
    throw new RXMLParseError("Failed to parse XML node", normalizedError);
  }
}

/**
 * Build node value with attributes if present
 */
