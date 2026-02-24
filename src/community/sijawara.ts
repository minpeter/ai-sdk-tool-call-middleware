import type { JSONValue, LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { morphFormatToolResponseAsXml } from "../core/prompts/morph-xml-prompt";
import {
  renderInputExamplesSection,
  safeStringifyInputExample,
} from "../core/prompts/shared/input-examples";
import { createToolMiddleware, morphXmlProtocol } from "../index";
import { stringify } from "../rxml";
import { escapeXmlMinimalText } from "../rxml/utils/helpers";

const XML_TAG_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function toSafeXmlTagName(name: string): string {
  return XML_TAG_NAME_REGEX.test(name) ? name : "tool";
}

function hasInvalidXmlKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasInvalidXmlKeys(entry));
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, nested]) =>
        !XML_TAG_NAME_REGEX.test(key) || hasInvalidXmlKeys(nested)
    );
  }

  return false;
}

export const sijawaraDetailedXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolResponsePromptTemplate: morphFormatToolResponseAsXml,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    const basePrompt = `You have access to callable functions (tools).
    Tool list/context:
    ${toolsJson}

    ===============================
    TOOL CALLING FORMAT
    ===============================
    - Use the XML-like format for tool calls:
      <tool_name>
        <parameter_name>
          value
        </parameter_name>
        ...
      </tool_name>

    ===============================
    ARRAY PARAMETERS
    ===============================
    - For array/multiple values, repeat the parameter for each value.
    - Example:
      <send_messages>
        <recipient>
          alice@example.com
        </recipient>
        <recipient>
          bob@example.com
        </recipient>
        <message>
          Hello!
        </message>
      </send_messages>

    ===============================
    SINGLE VALUE PARAMETERS
    ===============================
    - For single values, use one parameter block.
    - Example:
      <get_weather>
        <location>
          San Francisco
        </location>
      </get_weather>

    ===============================
    GENERAL RULES
    ===============================
    - First line: tool (function) name in angle brackets.
    - Parameters: each on their own line, in angle brackets, with name and value.
    - Include all required parameters. If info is missing, ask the user.
    - Do NOT use JSON—use only the specified XML-like format for tool calls.
    - If no call is needed, reply without a tool call.`;

    const inputExamplesText = renderSijawaraInputExamples(tools);
    if (inputExamplesText.length === 0) {
      return basePrompt;
    }

    return `${basePrompt}\n\n${inputExamplesText}`;
  },
});

export const sijawaraConciseXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolResponsePromptTemplate: morphFormatToolResponseAsXml,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    const basePrompt = `You have access to callable functions (tools).
    Tool list/context:
    ${toolsJson}

    STRICT CALLING RULES:
    - Use the XML-like format for tool calls:

      <tool_name>
        <parameter_name>
          value
        </parameter_name>
        ...
      </tool_name>

    - First line: the tool (function) name in angle brackets.
    - Parameters: each in their own angle brackets with name and value.
    - Include all required parameters. If info is missing, ask the user.
    - Do NOT use JSON. Use only the specified XML-like format.
    - If no call is needed, reply without a tool call.

    Example:
    <get_weather>
      <location>
        San Francisco
      </location>
    </get_weather>`;

    const inputExamplesText = renderSijawaraInputExamples(tools);
    if (inputExamplesText.length === 0) {
      return basePrompt;
    }

    return `${basePrompt}\n\n${inputExamplesText}`;
  },
});

function renderSijawaraInputExamples(
  tools: LanguageModelV3FunctionTool[]
): string {
  return renderInputExamplesSection({
    tools,
    renderExample: renderSijawaraInputExample,
  });
}

function renderSijawaraInputExample(toolName: string, input: unknown): string {
  const safeToolName = toSafeXmlTagName(toolName);

  if (hasInvalidXmlKeys(input)) {
    const fallbackContent = safeStringifyInputExample(input);
    const escapedFallback = escapeXmlMinimalText(fallbackContent);
    return `<${safeToolName}>${escapedFallback}</${safeToolName}>`;
  }

  try {
    return stringify(safeToolName, input as JSONValue, {
      suppressEmptyNode: false,
      format: true,
      minimalEscaping: true,
    });
  } catch (error) {
    const fallbackContent = safeStringifyInputExample(input, error);
    const escapedFallback = escapeXmlMinimalText(fallbackContent);
    return `<${safeToolName}>${escapedFallback}</${safeToolName}>`;
  }
}
