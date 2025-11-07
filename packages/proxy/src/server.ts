import { zodSchema } from "@ai-sdk/provider-utils";
import cors from "@fastify/cors";
import { generateText, streamText } from "ai";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodFirstPartyTypeKind, type ZodTypeAny } from "zod";
import { convertOpenAIRequestToAISDK } from "./openai-request-converter.js";
import {
  convertAISDKResultToOpenAI,
  createOpenAIStreamConverter,
} from "./response-converter.js";
import type {
  AISDKTool,
  Logger,
  OpenAIChatRequest,
  ProxyConfig,
} from "./types.js";

type ConvertedParams = ReturnType<typeof convertOpenAIRequestToAISDK>;

function serializeZodSchema(schema: ZodTypeAny | undefined): unknown {
  if (!schema) {
    return null;
  }

  const { typeName } = schema._def;

  switch (typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = schema._def.shape() as Record<string, ZodTypeAny>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldType = fieldSchema as ZodTypeAny;
        if (fieldType._def.typeName === ZodFirstPartyTypeKind.ZodOptional) {
          const inner = (fieldType._def as { innerType: ZodTypeAny }).innerType;
          properties[key] = serializeZodSchema(inner);
        } else {
          properties[key] = serializeZodSchema(fieldType);
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }
    case ZodFirstPartyTypeKind.ZodString: {
      return { type: "string" };
    }
    case ZodFirstPartyTypeKind.ZodNumber: {
      return { type: "number" };
    }
    case ZodFirstPartyTypeKind.ZodBoolean: {
      return { type: "boolean" };
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      return {
        type: "array",
        items: serializeZodSchema(schema._def.type),
      };
    }
    case ZodFirstPartyTypeKind.ZodEnum: {
      return {
        type: "string",
        enum: [...schema._def.values],
      };
    }
    case ZodFirstPartyTypeKind.ZodLiteral: {
      return {
        const: schema._def.value,
      };
    }
    case ZodFirstPartyTypeKind.ZodOptional: {
      return {
        optional: true,
        schema: serializeZodSchema(schema._def.innerType),
      };
    }
    case ZodFirstPartyTypeKind.ZodNullable: {
      return {
        nullable: true,
        schema: serializeZodSchema(schema._def.innerType),
      };
    }
    default: {
      return { type: typeName };
    }
  }
}

function serializeMessages(messages: OpenAIChatRequest["messages"]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    content: message.content,
    toolCalls: message.tool_calls,
  }));
}

function logIncomingRequest(openaiRequest: OpenAIChatRequest) {
  const toolNames = (openaiRequest.tools ?? [])
    .map((tool) => ("function" in tool ? tool.function?.name : undefined))
    .filter((name): name is string => Boolean(name));

  console.log(
    "[proxy] Incoming OpenAI request",
    JSON.stringify(
      {
        model: openaiRequest.model,
        stream: Boolean(openaiRequest.stream),
        temperature: openaiRequest.temperature,
        maxTokens: openaiRequest.max_tokens,
        toolNames,
        toolChoice: openaiRequest.tool_choice,
        messages: serializeMessages(openaiRequest.messages),
        tools: openaiRequest.tools,
      },
      null,
      2
    )
  );
}

function serializeAISDKMessages(messages: ConvertedParams["messages"]) {
  return messages?.map((message, index) => ({
    index,
    role: message.role,
    content: message.content,
  }));
}

function logRequestConversion(
  openaiRequest: OpenAIChatRequest,
  aisdkParams: ConvertedParams
) {
  const messages = aisdkParams.messages ?? [];
  console.log(
    "[proxy] Converted AI SDK params",
    JSON.stringify(
      {
        model: openaiRequest.model,
        hasSystemMessage: messages.some((message) => message.role === "system"),
        messages: serializeAISDKMessages(messages),
        tools: Object.entries(aisdkParams.tools ?? {}).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: serializeZodSchema(tool.inputSchema),
        })),
        temperature: aisdkParams.temperature,
        maxOutputTokens: aisdkParams.maxOutputTokens,
        stopSequences: aisdkParams.stopSequences,
      },
      null,
      2
    )
  );
}

export class OpenAIProxyServer {
  private readonly fastify: FastifyInstance;
  private readonly config: ProxyConfig;
  private readonly logger: Logger;

  constructor(config: ProxyConfig) {
    this.config = {
      port: 3000,
      host: "localhost",
      cors: true,
      ...config,
    };
    this.logger = (config.logger ?? console) as Logger;

    this.fastify = Fastify();

    // Enable CORS
    if (this.config.cors) {
      this.fastify.register(cors);
    }

    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Health check endpoint
    this.fastify.get(
      "/health",
      async (_request: FastifyRequest, _reply: FastifyReply) => ({
        status: "ok",
        timestamp: new Date().toISOString(),
      })
    );

    // OpenAI-compatible chat completions endpoint
    this.fastify.post(
      "/v1/chat/completions",
      (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const openaiRequest = request.body as OpenAIChatRequest;

          // Validate request
          if (
            !(openaiRequest.messages && Array.isArray(openaiRequest.messages))
          ) {
            return reply.code(400).send({
              error: {
                message: "Messages array is required",
                type: "invalid_request_error",
              },
            });
          }

          logIncomingRequest(openaiRequest);

          // Convert OpenAI request to AI SDK format
          const aisdkParams = convertOpenAIRequestToAISDK(openaiRequest);
          logRequestConversion(openaiRequest, aisdkParams);

          // Handle streaming vs non-streaming
          if (openaiRequest.stream) {
            return this.handleStreamingRequest(
              aisdkParams,
              openaiRequest,
              reply
            );
          }
          return this.handleNonStreamingRequest(
            aisdkParams,
            openaiRequest,
            reply
          );
        } catch (error) {
          this.logger.error("Request handling error:", error);
          return reply.code(500).send({
            error: {
              message: "Internal server error",
              type: "server_error",
            },
          });
        }
      }
    );

    // Models endpoint
    this.fastify.get("/v1/models", async () => ({
      object: "list",
      data: [
        {
          id: "wrapped-model",
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "ai-sdk-tool-proxy",
        },
      ],
    }));
  }

  // Merge server-defined tools (with execute) and request-defined tools (schema-only)
  // Server tools take precedence when names overlap.
  private mergeTools(
    serverTools?: Record<string, AISDKTool>,
    requestTools?: Record<string, AISDKTool>
  ) {
    const toProviderTool = (tool: AISDKTool | undefined): unknown => {
      if (!tool) {
        return;
      }

      return {
        description: tool.description,
        inputSchema: zodSchema(tool.inputSchema),
        ...(tool.execute ? { execute: tool.execute } : {}),
      };
    };

    const merged: Record<string, unknown> = {};

    for (const [name, t] of Object.entries(requestTools ?? {})) {
      const pt = toProviderTool(t);
      if (pt) {
        merged[name] = pt;
      }
    }

    for (const [name, t] of Object.entries(serverTools ?? {})) {
      const pt = toProviderTool(t);
      if (pt) {
        merged[name] = pt; // override request tool
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  private async handleStreamingRequest(
    // biome-ignore lint/suspicious/noExplicitAny: o sdk integration boundary
    aisdkParams: any,
    openaiRequest: OpenAIChatRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Set SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    try {
      const mergedTools = this.mergeTools(this.config.tools, aisdkParams.tools);
      const result = await streamText({
        model: this.config.model,
        ...aisdkParams,
        ...(mergedTools ? { tools: mergedTools } : {}),
      });

      const convert = createOpenAIStreamConverter(openaiRequest.model);
      for await (const chunk of result.fullStream) {
        const openaiChunks = convert(chunk);
        for (const openaiChunk of openaiChunks) {
          reply.raw.write(`data: ${openaiChunk.data}\n\n`);
        }
      }

      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (error) {
      this.logger.error("Streaming error:", error);
      reply.raw.write('data: {"error": {"message": "Streaming error"}}\n\n');
      reply.raw.end();
    }

    return reply;
  }

  private async handleNonStreamingRequest(
    // biome-ignore lint/suspicious/noExplicitAny: o sdk integration boundary
    aisdkParams: any,
    openaiRequest: OpenAIChatRequest,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const mergedTools = this.mergeTools(this.config.tools, aisdkParams.tools);
      const result = await generateText({
        model: this.config.model,
        ...aisdkParams,
        ...(mergedTools ? { tools: mergedTools } : {}),
      });

      const openaiResponse = convertAISDKResultToOpenAI(
        result,
        openaiRequest.model,
        false
      );

      reply.send(openaiResponse);
    } catch (error) {
      this.logger.error("Generation error:", error);
      return reply.code(500).send({
        error: {
          message: "Generation failed",
          type: "generation_error",
        },
      });
    }
  }

  async start(): Promise<void> {
    try {
      await this.fastify.listen({
        port: this.config.port || 3000,
        host: this.config.host || "localhost",
      });

      this.logger.info(
        `🚀 OpenAI Proxy Server running on http://${this.config.host}:${this.config.port}`
      );
      this.logger.info(
        `📡 Endpoint: http://${this.config.host}:${this.config.port}/v1/chat/completions`
      );
      this.logger.info(
        `🏥 Health: http://${this.config.host}:${this.config.port}/health`
      );
    } catch (error) {
      this.logger.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.fastify.close();
      this.logger.info("🛑 Server stopped");
    } catch (error) {
      this.logger.error("Error stopping server:", error);
    }
  }
}
