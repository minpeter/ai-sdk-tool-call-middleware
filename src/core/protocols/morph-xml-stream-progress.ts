import {
  isJSONObject,
  type JSONObject,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { type ParseOptions, parse } from "../../rxml";
import type { ToolInputSchemaDefinition } from "../../schema/tool-input-schema";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import {
  analyzeXmlFragmentForProgress,
  buildEmptyTrailingStringTagProgressContent,
  findTrailingUnclosedStringTag,
  getObjectSchemaPropertyNames,
  getObjectSchemaStringPropertyNames,
  getSchemaObjectProperty,
  isStrictStringSchemaProperty,
  schemaAllowsArrayType,
} from "./morph-xml-progress-analysis";

function isStableXmlProgressCandidate(options: {
  candidate: string;
  parsed: JSONObject;
  toolSchema: ToolInputSchemaDefinition | undefined;
}): boolean {
  const { candidate, parsed, toolSchema } = options;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const structure = analyzeXmlFragmentForProgress(candidate);
  if (!structure) {
    return false;
  }

  const schemaProperties = getObjectSchemaPropertyNames(toolSchema);
  if (!schemaProperties || schemaProperties.size === 0) {
    return false;
  }

  const parsedObject = parsed;
  const uniqueTopLevelTags = new Set(structure.topLevelTagNames);
  for (const tagName of uniqueTopLevelTags) {
    if (!schemaProperties.has(tagName)) {
      continue;
    }
    const schemaProperty = getSchemaObjectProperty(toolSchema, tagName);
    if (
      schemaProperty &&
      schemaAllowsArrayType(schemaProperty) &&
      !Array.isArray(parsedObject[tagName])
    ) {
      return false;
    }
  }

  if (structure.topLevelTagNames.length === 1) {
    const [onlyTopLevelTag] = structure.topLevelTagNames;
    if (
      !schemaProperties ||
      schemaProperties.size === 0 ||
      !schemaProperties.has(onlyTopLevelTag)
    ) {
      return false;
    }
  }

  return true;
}

export interface XmlStreamProgressResult {
  fullInput: string | null;
  /**
   * Name of the trailing unclosed string property tag when the progress
   * result came from the empty-trailing-string-tag repair branch. While this
   * branch is active, appended chunks that contain no tag boundary characters
   * cannot change the progress result, which lets the streaming caller skip
   * recomputation entirely (see emitToolInputProgress in morph-xml-protocol).
   */
  trailingStringTag: string | null;
  /**
   * Present when the trailing tag's value can be live-streamed: the property
   * is exactly string-typed (raw-slice extraction is the identity transform,
   * so a raw prefix is always a prefix of the final value) and the repaired
   * parse produced an args object to build progress candidates from.
   * `bodyStart` is the offset in toolContent where the raw value begins.
   */
  trailingValueStreaming: {
    argsBase: JSONObject;
    bodyStart: number;
  } | null;
}

function resolveTrailingStringTagProgress(options: {
  toolContent: string;
  toolSchema: ToolInputSchemaDefinition | undefined;
  tryParse: (content: string) => JSONObject | null;
  tryStringify: (args: JSONObject) => string | null;
}): XmlStreamProgressResult | null {
  const { toolContent, toolSchema, tryParse, tryStringify } = options;
  const stringPropertyNames = getObjectSchemaStringPropertyNames(toolSchema);
  if (!stringPropertyNames || stringPropertyNames.size === 0) {
    return null;
  }
  const trailingStringTag = findTrailingUnclosedStringTag({
    toolContent,
    stringPropertyNames,
  });
  if (!trailingStringTag) {
    return null;
  }
  const emptyRepair = buildEmptyTrailingStringTagProgressContent({
    toolContent,
    tagName: trailingStringTag,
  });
  const repaired =
    emptyRepair?.content ?? `${toolContent}</${trailingStringTag}>`;
  const parsedRepaired = tryParse(repaired);
  if (parsedRepaired === null) {
    return null;
  }
  const canStreamValue =
    emptyRepair !== null &&
    isJSONObject(parsedRepaired) &&
    isStrictStringSchemaProperty(toolSchema, trailingStringTag);
  return {
    fullInput: tryStringify(parsedRepaired),
    trailingStringTag,
    trailingValueStreaming: canStreamValue
      ? {
          argsBase: parsedRepaired,
          bodyStart: emptyRepair.bodyStart,
        }
      : null,
  };
}

export function parseXmlContentForStreamProgressWithMeta({
  toolContent,
  toolName,
  toolSchema,
  parseOptions,
  tools,
}: {
  toolContent: string;
  toolName: string;
  toolSchema: ToolInputSchemaDefinition | undefined;
  parseOptions?: ParseOptions;
  tools: LanguageModelV4FunctionTool[];
}): XmlStreamProgressResult {
  const tryParse = (content: string): JSONObject | null => {
    try {
      const parsed = parse(content, toolSchema, {
        ...(parseOptions ?? {}),
        repair: false,
        onError: undefined,
      });
      return isJSONObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const tryStringify = (args: JSONObject): string | null => {
    try {
      return stringifyToolInputWithSchema({
        toolName,
        args,
        tools,
      });
    } catch {
      return null;
    }
  };

  const strictFull = tryParse(toolContent);
  if (
    strictFull !== null &&
    isStableXmlProgressCandidate({
      candidate: toolContent,
      parsed: strictFull,
      toolSchema,
    })
  ) {
    return {
      fullInput: tryStringify(strictFull),
      trailingStringTag: null,
      trailingValueStreaming: null,
    };
  }

  const trailingResult = resolveTrailingStringTagProgress({
    toolContent,
    toolSchema,
    tryParse,
    tryStringify,
  });
  if (trailingResult) {
    return trailingResult;
  }

  let searchEnd = toolContent.length;
  while (searchEnd > 0) {
    const gtIndex = toolContent.lastIndexOf(">", searchEnd - 1);
    if (gtIndex === -1) {
      break;
    }
    const candidate = toolContent.slice(0, gtIndex + 1);
    if (!analyzeXmlFragmentForProgress(candidate)) {
      searchEnd = gtIndex;
      continue;
    }
    const parsedCandidate = tryParse(candidate);
    if (
      parsedCandidate !== null &&
      isStableXmlProgressCandidate({
        candidate,
        parsed: parsedCandidate,
        toolSchema,
      })
    ) {
      return {
        fullInput: tryStringify(parsedCandidate),
        trailingStringTag: null,
        trailingValueStreaming: null,
      };
    }
    searchEnd = gtIndex;
  }

  return {
    fullInput: null,
    trailingStringTag: null,
    trailingValueStreaming: null,
  };
}
