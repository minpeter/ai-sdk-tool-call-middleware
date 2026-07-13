import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { parse } from "../../rxml";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import {
  analyzeXmlFragmentForProgress,
  buildEmptyTrailingStringTagProgressContent,
  findTrailingUnclosedStringTag,
  getObjectSchemaPropertyNames,
  getObjectSchemaStringPropertyNames,
  getSchemaObjectProperty,
  schemaAllowsArrayType,
} from "./morph-xml-progress-analysis";

function isStableXmlProgressCandidate(options: {
  candidate: string;
  parsed: unknown;
  toolSchema: unknown;
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

  const parsedObject = parsed as Record<string, unknown>;
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

export function parseXmlContentForStreamProgress({
  toolContent,
  toolName,
  toolSchema,
  parseOptions,
  tools,
}: {
  toolContent: string;
  toolName: string;
  toolSchema: unknown;
  parseOptions?: Record<string, unknown>;
  tools: LanguageModelV4FunctionTool[];
}): string | null {
  const tryParse = (content: string): unknown | null => {
    try {
      return parse(content, toolSchema, {
        ...(parseOptions ?? {}),
        repair: false,
        onError: undefined,
      });
    } catch {
      return null;
    }
  };
  const tryStringify = (args: unknown): string | null => {
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
    return tryStringify(strictFull);
  }

  const stringPropertyNames = getObjectSchemaStringPropertyNames(toolSchema);
  if (stringPropertyNames && stringPropertyNames.size > 0) {
    const trailingStringTag = findTrailingUnclosedStringTag({
      toolContent,
      stringPropertyNames,
    });
    if (trailingStringTag) {
      const repaired =
        buildEmptyTrailingStringTagProgressContent({
          toolContent,
          tagName: trailingStringTag,
        }) ?? `${toolContent}</${trailingStringTag}>`;
      const parsedRepaired = tryParse(repaired);
      if (parsedRepaired !== null) {
        return tryStringify(parsedRepaired);
      }
    }
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
      return tryStringify(parsedCandidate);
    }
    searchEnd = gtIndex;
  }

  return null;
}
