import { JSONSchema7, LanguageModelV2FunctionTool } from "@ai-sdk/provider";

export type ToolCallMiddlewareProviderOptions = {
  toolCallMiddleware?: {
    // onError?: (message: string, metadata?: Record<string, unknown>) => void;

    // INTERNAL: set by transform-handler to propagate tool names when providers
    // strip `params.tools`. Used as a fallback in downstream handlers.
    toolNames?: string[];
    // INTERNAL: set by transform-handler to activate tool-choice fast-path.
    toolChoice?: { type: string };
    // INTERNAL: Field to preserve removed "params.tools" for passing to middleware
    originalTools?: Array<{
      name: string;
      inputSchema: string; // stringified JSONSchema7
    }>;
  };
};

export const originalToolsSchema = {
  encode: encodeOriginalTools,
  decode: decodeOriginalTools,
};

export function encodeOriginalTools(
  tools: LanguageModelV2FunctionTool[] | undefined
): Array<{ name: string; inputSchema: string }> {
  return (
    tools?.map(t => ({
      name: t.name,
      inputSchema: JSON.stringify(t.inputSchema),
    })) || []
  );
}

export function decodeOriginalTools(
  originalTools:
    | Array<{
        name: string;
        inputSchema: string; // stringified JSONSchema7
      }>
    | undefined
): LanguageModelV2FunctionTool[] {
  const tools =
    originalTools?.map(
      t =>
        ({
          name: t.name,
          inputSchema: JSON.parse(t.inputSchema) as JSONSchema7,
        }) as LanguageModelV2FunctionTool
    ) || [];

  return tools;
}

// export const originalToolsSchema = z.codec(
//   z.array(
//     z.object({
//       type: z.literal("function"),
//       name: z.string(),
//       inputSchema: z.record(z.string(), z.unknown()), // JSONSchema7 object
//     })
//   ),
//   z.array(z.object({ name: z.string(), inputSchema: z.string() })),
//   {
//     encode: originalTools =>
//       originalTools?.map(t => ({
//         type: "function" as const,
//         name: t.name,
//         inputSchema: JSON.parse(t.inputSchema),
//       })),
//     decode: originalTools =>
//       originalTools?.map(t => ({
//         name: t.name,
//         inputSchema: JSON.stringify(t.inputSchema),
//       })) || [],
//   }
// );

// export const toolCallMiddlewareProviderOptions = z.object({
//   toolNames: z.array(z.string()).optional(),

//   toolChoice: z.object({ type: z.string() }).optional(),

//   originalTools: originalToolsSchema,
// });

// export type ToolCallMiddlewareProviderOptions = z.infer<
//   typeof toolCallMiddlewareProviderOptions
// >;

export function isToolChoiceActive(params: {
  providerOptions?: {
    toolCallMiddleware?: {
      toolChoice?: { type: string };
    };
  };
}): boolean {
  const toolChoice = params.providerOptions?.toolCallMiddleware?.toolChoice;
  return !!(
    typeof params.providerOptions === "object" &&
    params.providerOptions !== null &&
    typeof params.providerOptions?.toolCallMiddleware === "object" &&
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice.type === "tool" || toolChoice.type === "required")
  );
}
