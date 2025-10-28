// Core functionality

// Builders
export {
  stringify,
  stringifyNode,
  stringifyNodes,
  toContentString,
} from "./builders/stringify";
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
// Schema integration
export {
  coerceBySchema,
  getSchemaType,
  unwrapJsonSchema,
} from "./schema/base-coercion";
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
  findAllTopLevelRanges,
  findFirstTopLevelRange,
} from "./schema/extraction";
// Utils
export { unescapeXml } from "./utils/helpers";

// Compatibility
export type Options = {
  textNodeName?: string;
  throwOnDuplicateStringTags?: boolean;
  onError?: (message: string, context?: Record<string, unknown>) => void;
};
