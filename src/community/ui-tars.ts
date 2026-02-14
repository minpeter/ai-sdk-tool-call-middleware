import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { createToolMiddleware, uiTarsXmlProtocol } from "../index";

export const uiTarsDetailedXmlToolMiddleware = createToolMiddleware({
  protocol: uiTarsXmlProtocol,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    return `You have access to callable functions (tools).
Tool list/context:
${toolsJson}

===============================
UI-TARS TOOL CALLING FORMAT
===============================
- When you need to call a tool, output ONLY tool-call markup and nothing else.
- No suffix, no extra text, no explanations, and no markdown code fences.

Tool calls MUST use this exact XML-like format:
<tool_call>
  <function=TOOL_NAME>
    <parameter=PARAM_NAME>VALUE</parameter>
    ...
  </function>
</tool_call>

===============================
ARRAY PARAMETERS
===============================
- For array/multiple values, repeat the same parameter tag for each value.
- Example:
<tool_call>
  <function=send_messages>
    <parameter=recipient>alice@example.com</parameter>
    <parameter=recipient>bob@example.com</parameter>
    <parameter=message>Hello!</parameter>
  </function>
</tool_call>

===============================
SINGLE VALUE PARAMETERS
===============================
- For single values, use one parameter tag.
- Example:
<tool_call>
  <function=get_weather>
    <parameter=location>San Francisco</parameter>
  </function>
</tool_call>

===============================
GENERAL RULES
===============================
- Include all required parameters. If info is missing, ask the user.
- Do NOT use JSON for tool calls. Use only the specified UI-TARS format.
- If no tool call is needed, reply with plain text and do NOT output <tool_call>.`;
  },
});
export const uiTarsConciseXmlToolMiddleware = createToolMiddleware({
  protocol: uiTarsXmlProtocol,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    return `You have access to callable functions (tools).
Tool list/context:
${toolsJson}

STRICT UI-TARS TOOL CALLING RULES:
- If calling a tool, output ONLY:

<tool_call>
  <function=TOOL_NAME>
    <parameter=PARAM_NAME>VALUE</parameter>
    ...
  </function>
</tool_call>

- No extra text before or after the tool call (no suffix).
- Repeat <parameter=PARAM_NAME> for arrays/multiple values.
- Include all required parameters. If info is missing, ask the user.
- If no call is needed, reply normally with plain text (no <tool_call>).`;
  },
});
