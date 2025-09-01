// Core functionality
export {
  filter,
  parse,
  parseNode,
  parseWithoutSchema,
  simplify,
} from "./core/parser";
export {
  createXMLStream,
  findElementByIdStream,
  findElementsByClassStream,
  parseFromStream,
  processXMLStream,
  XMLTransformStream,
} from "./core/stream";
export { XMLTokenizer } from "./core/tokenizer";

// Schema integration
export {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "./schema/coercion";
export {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
} from "./schema/extraction";

// Builders
export {
  stringify,
  stringifyNode,
  stringifyNodes,
  toContentString,
} from "./builders/stringify";

// Utils
export { unescapeXml } from "./utils/helpers";

// Types
export type { ParseOptions, RXMLNode, StringifyOptions } from "./core/types";

// Errors
export {
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  RXMLStreamError,
  RXMLStringifyError,
} from "./errors/types";

// Compatibility
export interface Options {
  textNodeName?: string;
  throwOnDuplicateStringTags?: boolean;
  onError?: (message: string, context?: Record<string, unknown>) => void;
}
