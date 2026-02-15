import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { formatToolResponseAsXml } from "../core/prompts/tool-response";
import { createToolMiddleware, uiTarsXmlProtocol } from "../index";

export const uiTarsDetailedXmlToolMiddleware = createToolMiddleware({
  protocol: uiTarsXmlProtocol,
  toolResponsePromptTemplate: formatToolResponseAsXml,
  toolSystemPromptTemplate(tools: LanguageModelV3FunctionTool[]) {
    const toolsJson = JSON.stringify(tools);
    return `You have access to callable functions (tools).
Tool list/context:
${toolsJson}

===============================
UI-TARS FUNCTION CALLING FORMAT
===============================
You MUST use the EXACT format below for ALL function calls:

<function=tool_name>
<parameter=parameter_name>value</parameter>
<parameter=another_parameter>value</parameter>
</function>

===============================
CRITICAL SYNTAX RULES
===============================
1. Start with <function=TOOL_NAME> (use the exact tool name from the list above)
2. Each parameter MUST be <parameter=PARAM_NAME>VALUE</parameter>
3. End with </function>
4. NO quotes around tool names or parameter names
5. NO extra spaces or characters
6. NO JSON format - only use this XML-like format

===============================
CORRECT EXAMPLES
===============================
Screenshot:
<function=computer>
<parameter=action>screenshot</parameter>
</function>

Click at coordinates:
<function=computer>
<parameter=action>left_click</parameter>
<parameter=coordinate>[100, 200]</parameter>
</function>

Type text:
<function=computer>
<parameter=action>type</parameter>
<parameter=text>Hello World</parameter>
</function>

Scroll:
<function=computer>
<parameter=action>scroll</parameter>
<parameter=coordinate>[500, 400]</parameter>
<parameter=scroll_direction>down</parameter>
<parameter=scroll_amount>3</parameter>
</function>

===============================
WRONG FORMATS (DO NOT USE)
===============================
❌ <function=function='screenshot'> (no quotes or extra text)
❌ <parameter=parameters> (must use actual parameter name)
❌ JSON format like {"action": "screenshot"}
❌ Any format other than the exact XML-like format above

===============================
EXECUTION RULES
===============================
- Use ONLY the tool names listed above
- Include ALL required parameters for each tool
- If you don't know a parameter value, ask the user
- After calling a function, STOP and wait for the result
- Do NOT add extra text before or after function calls`;
  },
});
