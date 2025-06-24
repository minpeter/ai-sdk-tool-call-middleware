import {
  JSONSchema7,
  LanguageModelV2FunctionTool,
  LanguageModelV2ProviderDefinedClientTool,
  LanguageModelV2ProviderDefinedServerTool,
} from "@ai-sdk/provider";

/**
 * Dynamically generates a JSON Schema using 'if/then/else' to simulate 'oneOf' behavior
 * for tool call validation. This is useful when the environment does not support 'oneOf' directly.
 *
 * The generated schema validates that the incoming data (a tool call)
 * matches exactly one of the provided tools based on its 'name' property,
 * and then applies the corresponding tool's 'parameters' schema to its 'arguments' property.
 *
 * @param tools An array of tool definitions (LanguageModelV2FunctionTool or LanguageModelV2ProviderDefinedTool).
 * Each tool must have a unique 'name' and its 'parameters' must be a valid JSON Schema.
 * @returns A JSONSchema7 object representing the dynamic validation logic.
 * @throws Error if a 'provider-defined' tool is encountered, as they are not supported by this middleware.
 */
export function createDynamicIfThenElseSchema(
  tools: (
    | LanguageModelV2FunctionTool
    | LanguageModelV2ProviderDefinedClientTool
    | LanguageModelV2ProviderDefinedServerTool
  )[]
): JSONSchema7 {
  // Explicitly specify the return type as JSONSchema7
  let currentSchema: JSONSchema7 = {};
  const toolNames: string[] = [];

  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];

    if (
      tool.type === "provider-defined-client" ||
      tool.type === "provider-defined-server"
    ) {
      throw new Error(
        "Provider-defined tools are not supported by this middleware. Please use custom tools."
      );
    }

    toolNames.unshift(tool.name);

    // TODO: Support for parallel calls in required or toolname state
    const toolCondition: JSONSchema7 = {
      if: {
        properties: {
          name: {
            const: tool.name,
          },
        },
        required: ["name"],
      },
      then: {
        properties: {
          name: {
            const: tool.name,
          },
          arguments: tool.inputSchema,
        },
        required: ["name", "arguments"],
      },
    };

    if (Object.keys(currentSchema).length > 0) {
      toolCondition.else = currentSchema;
    }

    currentSchema = toolCondition;
  }

  return {
    type: "object", // Explicitly specify type as "object"
    properties: {
      name: {
        type: "string",
        description: "Name of the tool to call",
        enum: toolNames,
      },
      arguments: {
        type: "object", // By default, arguments is also specified as object type
        description: "Argument object to be passed to the tool",
      },
    },
    required: ["name", "arguments"],
    ...currentSchema,
  };
}
