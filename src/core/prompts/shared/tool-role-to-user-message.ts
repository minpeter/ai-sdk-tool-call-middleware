import type {
  LanguageModelV3FilePart,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import type {
  ToolApprovalResponse,
  ToolContent,
  ToolResultPart,
} from "@ai-sdk/provider-utils";
import {
  normalizeToolResultForUserContent,
  type ToolResponseMediaStrategy,
  type ToolResponseUserContentPart,
} from "./tool-result-normalizer";

export type ToolResponsePromptTemplateResult =
  | string
  | ToolResponseUserContentPart[];

function formatApprovalResponse(part: ToolApprovalResponse): string {
  const status = part.approved ? "Approved" : "Denied";
  const reason = part.reason ? `: ${part.reason}` : "";
  return `[Tool Approval ${status}${reason}]`;
}

function toTextPart(text: string): LanguageModelV3TextPart {
  return {
    type: "text",
    text,
  };
}

function normalizeTemplateResult(
  result: ToolResponsePromptTemplateResult
): ToolResponseUserContentPart[] {
  if (typeof result === "string") {
    return [toTextPart(result)];
  }

  return result;
}

function appendSection(
  target: ToolResponseUserContentPart[],
  section: ToolResponseUserContentPart[]
): void {
  if (section.length === 0) {
    return;
  }

  if (target.length > 0) {
    target.push(toTextPart("\n"));
  }

  target.push(...section);
}

function mergeAdjacentTextParts(
  parts: ToolResponseUserContentPart[]
): Array<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  const merged: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = [];

  for (const part of parts) {
    const last = merged.at(-1);
    const canMergeTextParts =
      part.type === "text" &&
      last?.type === "text" &&
      part.providerOptions === undefined &&
      last.providerOptions === undefined;
    if (canMergeTextParts) {
      last.text += part.text;
      continue;
    }
    merged.push(part);
  }

  return merged;
}

export function createUserContentToolResponseTemplate(options?: {
  mediaStrategy?: ToolResponseMediaStrategy;
}): (toolResult: ToolResultPart) => ToolResponsePromptTemplateResult {
  return (toolResult) =>
    normalizeToolResultForUserContent(
      toolResult.output,
      options?.mediaStrategy
    );
}

export function toolRoleContentToUserTextMessage(options: {
  toolContent: ToolContent;
  toolResponsePromptTemplate: (
    toolResult: ToolResultPart
  ) => ToolResponsePromptTemplateResult;
}): LanguageModelV3Prompt[number] {
  const toolResultParts = options.toolContent.filter(
    (part): part is ToolResultPart => part.type === "tool-result"
  );
  const approvalResponseParts = options.toolContent.filter(
    (part): part is ToolApprovalResponse =>
      part.type === "tool-approval-response"
  );

  const sections: ToolResponseUserContentPart[] = [];

  for (const toolResult of toolResultParts) {
    const result = options.toolResponsePromptTemplate(toolResult);
    appendSection(sections, normalizeTemplateResult(result));
  }

  for (const approvalResponse of approvalResponseParts) {
    appendSection(sections, [
      toTextPart(formatApprovalResponse(approvalResponse)),
    ]);
  }

  const normalizedSections = sections.length > 0 ? sections : [toTextPart("")];

  return {
    role: "user",
    content: mergeAdjacentTextParts(normalizedSections),
  };
}
