import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";

interface ProviderCaptureOptions<Body> {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly middleware?: LanguageModelV4Middleware;
  readonly modelId: string;
  readonly name: string;
  readonly parseBody: (source: string) => Body;
  readonly prompt: LanguageModelV4Prompt;
  readonly tools: readonly LanguageModelV4FunctionTool[];
}

export function edgeProbeTools(
  includeInputExamples = false
): LanguageModelV4FunctionTool[] {
  const tool: LanguageModelV4FunctionTool = {
    type: "function",
    name: "edge_probe",
    description: "Probe exact JSON rendering.",
    inputSchema: {
      type: "object",
      properties: {
        zed: { type: "number", minimum: 1e-7, maximum: 1e21 },
        alpha: { type: "integer" },
        raw: { type: "string" },
      },
      required: ["zed"],
      additionalProperties: false,
    },
    strict: true,
  };
  if (includeInputExamples) {
    tool.inputExamples = [{ input: { zed: 1 } }];
  }
  return [tool];
}

function successfulProviderResponse(modelId: string): Response {
  return Response.json({
    id: "response-1",
    created: 0,
    model: modelId,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "done" },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  });
}

export async function captureProviderBody<Body>(
  options: ProviderCaptureOptions<Body>
): Promise<Body> {
  let captured: Body | undefined;
  const provider = createOpenAICompatible({
    name: options.name,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    fetch: (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a JSON request body");
      }
      captured = options.parseBody(init.body);
      return Promise.resolve(successfulProviderResponse(options.modelId));
    },
  });
  const rawModel = provider.chatModel(options.modelId);
  const model = options.middleware
    ? wrapLanguageModel({ model: rawModel, middleware: options.middleware })
    : rawModel;

  await model.doGenerate({
    prompt: options.prompt,
    tools: [...options.tools],
  });
  if (captured === undefined) {
    throw new TypeError("Provider did not issue a request");
  }
  return captured;
}
