/**
 * Robust XML Parser - Main Export
 *
 * This is the main entry point for the robust-xml parser.
 * It re-exports all functionality from the new modular implementation.
 */

// Re-export everything from the new implementation
export * from "./robust-xml/index";

// Maintain backward compatibility with the old API
import {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
  type Options,
  parse as newParse,
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  RXMLStringifyError,
  stringify as newStringify,
} from "./robust-xml/index";

// Export the main functions with the expected names
export const parse = newParse;
export const stringify = newStringify;
export {
  countTagOccurrences,
  extractRawInner,
  findFirstTopLevelRange,
  type Options,
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  RXMLStringifyError,
};
