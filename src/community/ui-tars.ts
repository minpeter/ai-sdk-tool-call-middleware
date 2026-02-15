import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { formatToolResponseAsXml } from "../core/prompts/tool-response";
import { createToolMiddleware, uiTarsXmlProtocol } from "../index";

/**
 * UI-TARS middleware using a custom protocol that handles <function=name> syntax
 */
export const uiTarsToolMiddleware = createToolMiddleware({
  protocol: uiTarsXmlProtocol,
  toolResponsePromptTemplate: formatToolResponseAsXml,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    return `You have access to callable functions. Use the XML format below for ALL function calls.

FORMAT:
<tool_call>
<function=TOOL_NAME>
<parameter=PARAM_NAME>VALUE</parameter>
</function>
</tool_call>

RULES:
1. Always wrap calls in <tool_call>...</tool_call>.
2. Always include <function=...>...</function> and ALWAYS include the closing </function> tag.
3. Each parameter must be its own <parameter=NAME>VALUE</parameter> tag.
4. After calling a function, STOP and wait for the result.
5. For multiple calls, emit separate <tool_call> blocks (one call per block).

EXAMPLE (single call):
<tool_call>
<function=get_weather>
<parameter=city>Seoul</parameter>
<parameter=unit>celsius</parameter>
</function>
</tool_call>

EXAMPLE (multiple calls):
<tool_call>
<function=get_weather>
<parameter=city>Tokyo</parameter>
</function>
</tool_call>

<tool_call>
<function=calculator>
<parameter=expression>15 * 37</parameter>
</function>
</tool_call>

Available tools:
${toolsJson}`;
  },
});
