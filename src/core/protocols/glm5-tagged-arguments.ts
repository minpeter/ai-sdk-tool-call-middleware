import type { JSONObject, JSONValue } from "@ai-sdk/provider";
import {
  isSchemaRecord,
  type ToolInputSchema,
  type ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../utils/tool-call-coercion";
import { getToolInputPropertySchema } from "../utils/tool-call-object-schema";
import type { ResolvedGlm5ProtocolOptions } from "./glm5-call-types";
import {
  isPrototypeSensitiveRawArgumentKey,
  resolveArgumentName,
} from "./glm5-name-resolution";
import {
  findGlm5StructuralValueClose,
  findGlm5Tag,
  type Glm5StructuralTag,
  glm5PartialTagOverlap,
} from "./glm5-tag-scanning";
import {
  isIncrementallyStreamableGlm5StringSchema,
  normalizeGlm5StringValue,
  parseCompletedGlm5Value,
  safeAssignGlm5Arg,
} from "./glm5-value-parsing";

interface TaggedArgument {
  consumedUntil: number;
  hasPartialValue: boolean;
  nextTagCursor: number;
  rawKey: string;
  rawValue: string;
  valueIsComplete: boolean;
}

type TaggedArgumentSearch =
  | { kind: "found"; value: TaggedArgument }
  | { kind: "stop" };

type TaggedArgumentValue =
  | { kind: "rejected" | "skipped" }
  | { kind: "value"; value: JSONValue };

interface ParsedGlm5TaggedArguments {
  consumedUntil: number;
  hasPartialValue: boolean;
}

function schemaObject(
  schema: ToolInputSchemaDefinition | undefined
): ToolInputSchema | undefined {
  return typeof schema === "object" && isSchemaRecord(schema)
    ? schema
    : undefined;
}

function findNextTaggedArgument(options: {
  body: string;
  complete: boolean;
  recoveries: string[];
  tagCursor: number;
  tags: Glm5StructuralTag[];
}): TaggedArgumentSearch {
  const keyOpenIndex = findGlm5Tag(
    options.tags,
    options.tagCursor,
    "arg_key",
    false
  );
  const keyOpen = options.tags[keyOpenIndex];
  if (!keyOpen) {
    return { kind: "stop" };
  }
  const keyCloseIndex = findGlm5Tag(
    options.tags,
    keyOpenIndex + 1,
    "arg_key",
    true
  );
  const valueOpenIndex = findGlm5Tag(
    options.tags,
    keyOpenIndex + 1,
    "arg_value",
    false
  );
  const valueOpen = options.tags[valueOpenIndex];
  if (!valueOpen) {
    return { kind: "stop" };
  }

  const keyClose = options.tags[keyCloseIndex];
  const hasKeyClose = Boolean(keyClose && keyClose.start < valueOpen.start);
  const keyEnd = hasKeyClose && keyClose ? keyClose.start : valueOpen.start;
  if (!hasKeyClose) {
    options.recoveries.push("recovered-missing-arg-key-close");
  }

  const valueCloseIndex = findGlm5StructuralValueClose(
    options.body,
    options.tags,
    valueOpenIndex + 1
  );
  const valueClose = options.tags[valueCloseIndex];
  if (valueClose) {
    return {
      kind: "found",
      value: {
        consumedUntil: valueClose.end,
        hasPartialValue: false,
        nextTagCursor: valueCloseIndex + 1,
        rawKey: options.body.slice(keyOpen.end, keyEnd).trim(),
        rawValue: options.body.slice(valueOpen.end, valueClose.start),
        valueIsComplete: true,
      },
    };
  }

  let rawValue = options.body.slice(valueOpen.end);
  if (options.complete) {
    options.recoveries.push("recovered-missing-arg-value-close");
  } else {
    const overlap = glm5PartialTagOverlap(rawValue);
    if (overlap > 0) {
      rawValue = rawValue.slice(0, -overlap);
    }
  }
  return {
    kind: "found",
    value: {
      consumedUntil: options.body.length,
      hasPartialValue: !options.complete,
      nextTagCursor: options.tags.length,
      rawKey: options.body.slice(keyOpen.end, keyEnd).trim(),
      rawValue,
      valueIsComplete: options.complete,
    },
  };
}

function parseTaggedArgumentValue(options: {
  argument: TaggedArgument;
  propertySchema: ToolInputSchemaDefinition | undefined;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  recoveries: string[];
}): TaggedArgumentValue {
  if (options.propertySchema === false) {
    return options.argument.valueIsComplete
      ? { kind: "rejected" }
      : { kind: "skipped" };
  }
  const propertySchema = schemaObject(options.propertySchema);
  if (!options.argument.valueIsComplete) {
    if (!isIncrementallyStreamableGlm5StringSchema(propertySchema)) {
      return { kind: "skipped" };
    }
    const value = normalizeGlm5StringValue({
      complete: false,
      mode: options.protocolOptions.stringBoundaryNormalization,
      value: options.argument.rawValue,
    });
    return toolCallInputHasSchemaAwarePrototypeSensitiveValue(
      value,
      propertySchema
    )
      ? { kind: "skipped" }
      : { kind: "value", value };
  }

  const parsed = parseCompletedGlm5Value(
    options.argument.rawValue,
    propertySchema,
    options.protocolOptions.stringBoundaryNormalization,
    options.protocolOptions.recoverOpaqueObjectReferences
  );
  if (!parsed.ok) {
    return { kind: "rejected" };
  }
  if (parsed.recovery) {
    options.recoveries.push(parsed.recovery);
  }
  return { kind: "value", value: parsed.value };
}

function assignTaggedArgument(options: {
  args: JSONObject;
  argument: TaggedArgument;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  recoveries: string[];
  schema: ToolInputSchemaDefinition | undefined;
}): "assigned" | "rejected" | "skipped" {
  if (
    isPrototypeSensitiveRawArgumentKey(options.argument.rawKey) ||
    options.schema === false
  ) {
    return "rejected";
  }
  const resolvedKey = resolveArgumentName({
    args: options.args,
    rawName: options.argument.rawKey,
    recoverNames: options.protocolOptions.recoverNames,
    schema: schemaObject(options.schema),
  });
  if (!resolvedKey) {
    options.recoveries.push("dropped-unknown-argument-key");
    return "skipped";
  }
  if (resolvedKey.recovered) {
    options.recoveries.push("recovered-argument-key");
  }
  const propertySchema = getToolInputPropertySchema(
    options.schema ?? true,
    resolvedKey.value,
    options.args
  );
  const parsedValue = parseTaggedArgumentValue({
    argument: options.argument,
    propertySchema,
    protocolOptions: options.protocolOptions,
    recoveries: options.recoveries,
  });
  if (parsedValue.kind !== "value") {
    return parsedValue.kind;
  }
  return safeAssignGlm5Arg(
    options.args,
    resolvedKey.value,
    parsedValue.value,
    options.recoveries
  )
    ? "assigned"
    : "rejected";
}

export function parseGlm5TaggedArguments(options: {
  args: JSONObject;
  argsStart: number;
  body: string;
  complete: boolean;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  recoveries: string[];
  schema: ToolInputSchemaDefinition | undefined;
  tags: Glm5StructuralTag[];
}): ParsedGlm5TaggedArguments | null {
  let hasPartialValue = false;
  let tagCursor = 0;
  let consumedUntil = options.argsStart;
  while (tagCursor < options.tags.length) {
    const found = findNextTaggedArgument({
      body: options.body,
      complete: options.complete,
      recoveries: options.recoveries,
      tagCursor,
      tags: options.tags,
    });
    if (found.kind === "stop") {
      break;
    }
    const argument = found.value;
    const {
      consumedUntil: argumentConsumedUntil,
      hasPartialValue: argumentHasPartialValue,
      nextTagCursor,
    } = argument;
    tagCursor = nextTagCursor;
    consumedUntil = argumentConsumedUntil;
    hasPartialValue ||= argumentHasPartialValue;
    const assignment = assignTaggedArgument({
      args: options.args,
      argument,
      protocolOptions: options.protocolOptions,
      recoveries: options.recoveries,
      schema: options.schema,
    });
    if (assignment === "rejected") {
      return null;
    }
  }
  return { consumedUntil, hasPartialValue };
}
