import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import type { ToolResultPart } from "@ai-sdk/provider-utils";
import YAML from "yaml";
import { escapeXmlMinimalText } from "../../rxml/utils/helpers";
import { morphFormatToolResponseAsXml } from "./morph-xml-prompt";
import {
  renderInputExamplesSection,
  safeStringifyInputExample,
} from "./shared/input-examples";

const XML_TAG_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function toSafeXmlTagName(name: string): string {
  return XML_TAG_NAME_REGEX.test(name) ? name : "tool";
}

export function yamlXmlSystemPromptTemplate(
  tools: LanguageModelV3FunctionTool[],
  includeMultilineExample = true
): string {
  const toolsJson = JSON.stringify(tools);
  const inputExamplesText = renderInputExamplesSection({
    tools,
    renderExample: renderYamlXmlInputExample,
  });
  const multilineExample = includeMultilineExample
    ? `

For multiline values, use YAML's literal block syntax:
<write_file>
file_path: /tmp/example.txt
contents: |
  First line
  Second line
  Third line
</write_file>`
    : "";

  const basePrompt = `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${toolsJson}</tools>

# Format

Use exactly one XML element whose tag name is the function name.
Inside the XML element, specify parameters using YAML syntax (key: value pairs).

# Example
<get_weather>
location: New York
unit: celsius
</get_weather>${multilineExample}

# Rules
- Parameter names and values must follow the schema exactly.
- Use proper YAML syntax for values (strings, numbers, booleans, arrays, objects).
- Each required parameter must appear once.
- Do not add functions or parameters not in the schema.
- After calling a tool, you will receive a response. Use this result to answer the user.
- Do NOT ask clarifying questions. Use reasonable defaults for optional parameters.
- If a task requires multiple function calls, make ALL of them at once.`;

  if (inputExamplesText.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${inputExamplesText}`;
}

function renderYamlXmlInputExample(toolName: string, input: unknown): string {
  const safeToolName = toSafeXmlTagName(toolName);
  let yamlBody = "null";

  try {
    const yaml = YAML.stringify(input).trimEnd();
    yamlBody = yaml.length > 0 ? yaml : "null";
  } catch (error) {
    yamlBody = safeStringifyInputExample(input, error);
  }

  const escapedYamlBody = escapeXmlMinimalText(yamlBody);
  return `<${safeToolName}>\n${escapedYamlBody}\n</${safeToolName}>`;
}

export function formatToolResponseAsYaml(toolResult: ToolResultPart): string {
  return morphFormatToolResponseAsXml(toolResult);
}
