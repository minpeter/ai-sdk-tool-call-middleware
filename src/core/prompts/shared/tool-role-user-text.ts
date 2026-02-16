import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type {
  ToolApprovalResponse,
  ToolContent,
  ToolResultPart,
} from "@ai-sdk/provider-utils";

function formatApprovalResponse(part: ToolApprovalResponse): string {
  const status = part.approved ? "Approved" : "Denied";
  const reason = part.reason ? `: ${part.reason}` : "";
  return `[Tool Approval ${status}${reason}]`;
}

export function toolRoleContentToUserTextMessage(options: {
  toolContent: ToolContent;
  toolResponsePromptTemplate: (toolResult: ToolResultPart) => string;
}): LanguageModelV3Prompt[number] {
  const toolResultParts = options.toolContent.filter(
    (part): part is ToolResultPart => part.type === "tool-result"
  );
  const approvalResponseParts = options.toolContent.filter(
    (part): part is ToolApprovalResponse =>
      part.type === "tool-approval-response"
  );

  const resultTexts = toolResultParts.map((toolResult) => {
    return options.toolResponsePromptTemplate(toolResult);
  });
  const approvalTexts = approvalResponseParts.map(formatApprovalResponse);
  const allTexts = [...resultTexts, ...approvalTexts];

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: allTexts.join("\n"),
      },
    ],
  };
}
