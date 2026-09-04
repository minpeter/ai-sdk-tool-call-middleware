import type { JSONValue, LanguageModelV4Content } from "@ai-sdk/provider";
import type {
  ProtocolMetadata,
  ProtocolMetadataValue,
  TCMCoreProtocol,
} from "../../protocols/protocol-interface";

interface AssistantToolCallTextConversionOptions {
  onError?: (message: string, metadata?: ProtocolMetadata) => void;
}

type UnsupportedAssistantContent = Exclude<
  LanguageModelV4Content,
  { readonly type: "reasoning" | "text" | "tool-call" }
>;

type AssistantFileData = Extract<
  UnsupportedAssistantContent,
  { readonly type: "file" | "reasoning-file" }
>["data"];

function projectJsonValue(value: JSONValue | undefined): ProtocolMetadataValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(projectJsonValue);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, projectJsonValue(entry)])
  );
}

function unprojectableSdkValue(value: never): never {
  throw new TypeError(`Unprojectable SDK value: ${String(value)}`);
}

function projectFileData(data: AssistantFileData): ProtocolMetadata {
  switch (data.type) {
    case "data":
      return {
        type: data.type,
        data:
          typeof data.data === "string"
            ? data.data
            : { type: "Uint8Array", values: Array.from(data.data) },
      };
    case "url":
      return {
        type: data.type,
        url: { type: "URL", value: data.url.href },
      };
    default:
      return unprojectableSdkValue(data);
  }
}

function optionalProviderMetadata(
  item: UnsupportedAssistantContent
): ProtocolMetadata {
  return item.providerMetadata === undefined
    ? {}
    : { providerMetadata: projectJsonValue(item.providerMetadata) };
}

function projectUnsupportedContent(
  item: UnsupportedAssistantContent
): ProtocolMetadata {
  switch (item.type) {
    case "custom":
      return {
        type: item.type,
        kind: item.kind,
        ...optionalProviderMetadata(item),
      };
    case "file":
    case "reasoning-file":
      return {
        type: item.type,
        mediaType: item.mediaType,
        data: projectFileData(item.data),
        ...optionalProviderMetadata(item),
      };
    case "source":
      switch (item.sourceType) {
        case "url":
          return {
            type: item.type,
            sourceType: item.sourceType,
            id: item.id,
            url: item.url,
            ...(item.title === undefined ? {} : { title: item.title }),
            ...optionalProviderMetadata(item),
          };
        case "document":
          return {
            type: item.type,
            sourceType: item.sourceType,
            id: item.id,
            mediaType: item.mediaType,
            title: item.title,
            ...(item.filename === undefined ? {} : { filename: item.filename }),
            ...optionalProviderMetadata(item),
          };
        default:
          return unprojectableSdkValue(item);
      }
    case "tool-approval-request":
      return {
        type: item.type,
        approvalId: item.approvalId,
        toolCallId: item.toolCallId,
        ...optionalProviderMetadata(item),
      };
    case "tool-result":
      return {
        type: item.type,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result: projectJsonValue(item.result),
        ...(item.isError === undefined ? {} : { isError: item.isError }),
        ...(item.preliminary === undefined
          ? {}
          : { preliminary: item.preliminary }),
        ...(item.dynamic === undefined ? {} : { dynamic: item.dynamic }),
        ...optionalProviderMetadata(item),
      };
    default:
      return unprojectableSdkValue(item);
  }
}

function metadataContent(
  item: UnsupportedAssistantContent,
  serializedContent: string
): ProtocolMetadataValue {
  try {
    return projectUnsupportedContent(item);
  } catch {
    return `[unprojectable SDK content] ${serializedContent}`;
  }
}

export function assistantToolCallsToTextContent(options: {
  content: LanguageModelV4Content[];
  protocol: TCMCoreProtocol;
  conversionOptions?: AssistantToolCallTextConversionOptions;
}): LanguageModelV4Content[] {
  const newContent: LanguageModelV4Content[] = [];
  for (const item of options.content) {
    switch (item.type) {
      case "tool-call":
        newContent.push({
          type: "text",
          text: options.protocol.formatToolCall(item),
        });
        break;
      case "text":
      case "reasoning":
        newContent.push(item);
        break;
      default: {
        const serializedContent = JSON.stringify(item) ?? String(item);
        options.conversionOptions?.onError?.(
          "tool-call-middleware: unknown assistant content; stringifying for provider compatibility",
          { content: metadataContent(item, serializedContent) }
        );
        newContent.push({
          type: "text",
          text: serializedContent,
        });
        break;
      }
    }
  }

  const textContent = newContent.filter((entry) => entry.type === "text");
  if (textContent.length !== newContent.length) {
    return newContent;
  }

  return [
    {
      type: "text",
      text: textContent.map((entry) => entry.text).join("\n"),
    },
  ];
}
