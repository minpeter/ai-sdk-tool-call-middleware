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
    return `You have access to callable functions (tools).
Tool list/context:
${toolsJson}

===============================
UI-TARS FUNCTION CALLING FORMAT
===============================
You MUST use the EXACT format below for ALL function calls:

<tool_call>
<function=tool_name>
<parameter=parameter_name>
value
</parameter>
<parameter=another_parameter>
value
</parameter>
</function>
</tool_call>

===============================
CRITICAL SYNTAX RULES
===============================
1. Start with <tool_call>
2. Next line must be <function=TOOL_NAME> (use the exact tool name from the list above)
3. Each parameter MUST use opening/closing tags:
   <parameter=PARAM_NAME>
   VALUE
   </parameter>
4. End the function with </function>
5. End the tool call with </tool_call>
6. NO quotes around tool names or parameter names
7. NO extra spaces or characters
8. NO JSON format - only use this XML-like format

===============================
CORRECT EXAMPLES
===============================
Screenshot:
<tool_call>
<function=computer>
<parameter=action>
screenshot
</parameter>
</function>
</tool_call>

Click at coordinates:
<tool_call>
<function=computer>
<parameter=action>
left_click
</parameter>
<parameter=coordinate>
[100, 200]
</parameter>
</function>
</tool_call>

Type text:
<tool_call>
<function=computer>
<parameter=action>
type
</parameter>
<parameter=text>
Hello World
</parameter>
</function>
</tool_call>

Scroll:
<tool_call>
<function=computer>
<parameter=action>
scroll
</parameter>
<parameter=coordinate>
[500, 400]
</parameter>
<parameter=scroll_direction>
down
</parameter>
<parameter=scroll_amount>
3
</parameter>
</function>
</tool_call>

===============================
WRONG FORMATS (DO NOT USE)
===============================
❌ Missing <tool_call>...</tool_call> wrapper
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
- Do NOT add extra text before or after tool calls`;
  },
});
