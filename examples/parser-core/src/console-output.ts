const REASONING_COLOR = "\x1b[33m";
const RESET_COLOR = "\x1b[0m";

type ToolCallLike = {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
};

type ToolResultLike = {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
};

type StepLike = {
  text?: unknown;
  reasoning?: unknown;
  reasoningText?: unknown;
  toolCalls?: ToolCallLike[];
  toolResults?: ToolResultLike[];
};

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const stringifyUnknown = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractText = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).join("");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.value === "string") {
      return record.value;
    }
  }
  return stringifyUnknown(value);
};

const unwrapToolOutput = (output: unknown): unknown => {
  if (!output || typeof output !== "object") {
    return output;
  }
  if (!hasOwn(output, "type")) {
    return output;
  }
  const typed = output as Record<string, unknown>;
  const type = typed.type;
  switch (type) {
    case "text":
      return typed.value ?? "";
    case "json":
      return typed.value;
    case "execution-denied": {
      const reason = typeof typed.reason === "string" ? typed.reason : "";
      return reason ? `[Execution Denied: ${reason}]` : "[Execution Denied]";
    }
    case "error-text":
      return `[Error: ${typed.value ?? ""}]`;
    case "error-json":
      return `[Error: ${stringifyUnknown(typed.value)}]`;
    case "content": {
      const value = typed.value;
      if (!Array.isArray(value)) {
        return "[Unknown content]";
      }
      return value
        .map((part) => {
          if (!part || typeof part !== "object") {
            return "[Unknown content]";
          }
          const contentPart = part as Record<string, unknown>;
          switch (contentPart.type) {
            case "text":
              return typeof contentPart.text === "string"
                ? contentPart.text
                : "";
            case "image-data":
              return `[Image: ${contentPart.mediaType ?? "unknown"}]`;
            case "image-url":
              return `[Image URL: ${contentPart.url ?? "unknown"}]`;
            case "image-file-id":
              return `[Image ID: ${stringifyUnknown(contentPart.fileId)}]`;
            case "file-data": {
              const filename =
                typeof contentPart.filename === "string"
                  ? contentPart.filename
                  : "";
              const mediaType =
                typeof contentPart.mediaType === "string"
                  ? contentPart.mediaType
                  : "unknown";
              return filename
                ? `[File: ${filename} (${mediaType})]`
                : `[File: ${mediaType}]`;
            }
            case "file-url":
              return `[File URL: ${contentPart.url ?? "unknown"}]`;
            case "file-id":
              return `[File ID: ${stringifyUnknown(contentPart.fileId)}]`;
            case "media":
              return `[Media: ${contentPart.mediaType ?? "unknown"}]`;
            case "custom":
              return "[Custom content]";
            default:
              return "[Unknown content]";
          }
        })
        .join("\n");
    }
    default:
      return output;
  }
};

export function printStepLikeStream(step: StepLike) {
  const explicitReasoning =
    typeof step.reasoningText === "string" ? step.reasoningText : "";
  const reasoningText = explicitReasoning || "";
  const text = extractText(step.text);
  if (reasoningText && reasoningText !== text) {
    process.stdout.write(`${REASONING_COLOR}${reasoningText}${RESET_COLOR}`);
  }
  if (text) {
    process.stdout.write(text);
  }

  const toolCallsById = new Map<string, ToolCallLike>();
  for (const call of step.toolCalls ?? []) {
    if (call.toolCallId) {
      toolCallsById.set(call.toolCallId, call);
    }
  }

  for (const result of step.toolResults ?? []) {
    const call = result.toolCallId
      ? toolCallsById.get(result.toolCallId)
      : undefined;
    const name = result.toolName ?? call?.toolName ?? "unknown";
    const input = hasOwn(result, "input") ? result.input : call?.input;

    console.log({
      name,
      input,
      output: unwrapToolOutput(result.output),
    });
  }
}

export function printComplete() {
  console.log("\n\n<Complete>");
}
