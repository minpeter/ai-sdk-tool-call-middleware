/**
 * Core types for the robust-xml parser
 * Based on TXML structure but enhanced for schema-aware parsing
 */

export type OnErrorFn = (
  message: string,
  metadata?: Record<string, unknown>
) => void;

/**
 * Represents a parsed XML node in the DOM tree
 */
export interface RXMLNode {
  attributes: Record<string, string | null>;
  children: (RXMLNode | string)[];
  tagName: string;
}

/**
 * Options for XML parsing
 */
export interface ParseOptions {
  /** Filter function for nodes */
  filter?: (
    node: RXMLNode,
    index: number,
    depth: number,
    path: string
  ) => boolean;
  /** Keep comments in the parsed result */
  keepComments?: boolean;
  /** Keep whitespace like spaces, tabs and line breaks as string content */
  keepWhitespace?: boolean;
  /** Maximum reparses when repair heuristics are enabled */
  maxReparses?: number;
  /** Array of tag names that don't have children and don't need to be closed */
  noChildNodes?: string[];
  /** Error handling callback */
  onError?: OnErrorFn;
  /** Whether to parse a single node instead of children */
  parseNode?: boolean;
  /** Position to start parsing from (for streaming) */
  pos?: number;
  /**
   * Apply internal repair heuristics for fragment parsing.
   * When enabled, parsing attempts normalization/repair before throwing.
   */
  repair?: boolean;
  /** Whether to set position information in result */
  setPos?: boolean;
  /** Simplify the result structure */
  simplify?: boolean;
  /** Name of the text node property (default: "#text") */
  textNodeName?: string;
  /** Whether to throw on duplicate string tags */
  throwOnDuplicateStringTags?: boolean;
}

/**
 * Options for XML stringification
 */
export interface StringifyOptions {
  /**
   * Whether to include the XML declaration
   */
  declaration?: boolean;
  /** Whether to format the output with indentation */
  format?: boolean;
  /**
   * Whether to use minimal escaping per XML 1.0:
   * - In character data: escape '&' and '<' (and '>' only in ']]>' sequence)
   * - In attribute values: escape '&', '<', and only the wrapping quote
   * Defaults to false (conservative escaping of &, <, >, ", ')
   */
  minimalEscaping?: boolean;
  /** Error handling callback */
  onError?: OnErrorFn;
  /**
   * Whether to serialize boolean-like attributes (value === null)
   * as name="name" to follow strict XML attribute rules.
   * When false (default), serialize as a convenience flag without value
   * (e.g., <item checked>), for compatibility with existing outputs.
   */
  strictBooleanAttributes?: boolean;
  /** Whether to suppress empty nodes */
  suppressEmptyNode?: boolean;
}

/**
 * Character code constants for efficient parsing
 */
export const CharCodes = {
  OPEN_BRACKET: "<".charCodeAt(0),
  CLOSE_BRACKET: ">".charCodeAt(0),
  MINUS: "-".charCodeAt(0),
  SLASH: "/".charCodeAt(0),
  EXCLAMATION: "!".charCodeAt(0),
  QUESTION: "?".charCodeAt(0),
  SINGLE_QUOTE: "'".charCodeAt(0),
  DOUBLE_QUOTE: '"'.charCodeAt(0),
  OPEN_CORNER_BRACKET: "[".charCodeAt(0),
  CLOSE_CORNER_BRACKET: "]".charCodeAt(0),
  SPACE: " ".charCodeAt(0),
  TAB: "\t".charCodeAt(0),
  NEWLINE: "\n".charCodeAt(0),
  CARRIAGE_RETURN: "\r".charCodeAt(0),
} as const;

/**
 * Default self-closing HTML tags
 */
export const DEFAULT_NO_CHILD_NODES = [
  "img",
  "br",
  "input",
  "meta",
  "link",
  "hr",
  "area",
  "base",
  "col",
  "embed",
  "param",
  "source",
  "track",
  "wbr",
] as const;

/**
 * Name spacer characters for tag name parsing
 */
export const NAME_SPACER = "\r\n\t>/= ";
