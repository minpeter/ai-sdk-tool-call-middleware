import { createToolMiddleware, morphXmlProtocol } from "../index";

/**
 * A community-contributed middleware that uses morphXmlProtocol
 * with a more detailed system prompt template for function calling.
 *
 * Originally contributed by: sijawara
 * Source: https://github.com/minpeter/ai-sdk-tool-call-middleware/issues/51#issuecomment-3234519376
 */
export const sijawaraDetailedXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You have access to callable functions (tools).
    Tool list/context:
    ${tools}

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
  },
});

/**
 * A community-contributed middleware that uses morphXmlProtocol
 * with a more concise system prompt template for function calling.
 *
 * Originally contributed by: sijawara
 * Source: https://github.com/minpeter/ai-sdk-tool-call-middleware/issues/51#issuecomment-3234519376
 */
export const sijawaraConciseXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You have access to callable functions (tools).
    Tool list/context:
    ${tools}

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
  },
});
