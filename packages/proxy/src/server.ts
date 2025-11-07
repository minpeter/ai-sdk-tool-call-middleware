import cors from "@fastify/cors";
import { generateText, streamText } from "ai";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { convertOpenAIRequestToAISDK } from "./converters.js";
import {
  convertAISDKResultToOpenAI,
  convertAISDKStreamChunkToOpenAI,
} from "./response-converter.js";
import type { OpenAIChatRequest, ProxyConfig } from "./types.js";

type ConvertedParams = ReturnType<typeof convertOpenAIRequestToAISDK>;

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function summarizeMessages(messages: OpenAIChatRequest["messages"]) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    contentPreview:
      typeof message.content === "string" && message.content
        ? truncate(message.content)
        : undefined,
    toolCalls:
      Array.isArray(message.tool_calls)
        ? message.tool_calls.map((toolCall) => toolCall.function?.name).filter(Boolean)
        : undefined,
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
        messages: summarizeMessages(openaiRequest.messages),
      },
      null,
      2
    )
  );
}

function logRequestConversion(
  openaiRequest: OpenAIChatRequest,
  aisdkParams: ConvertedParams
) {
  console.log(
    "[proxy] Converted AI SDK params",
    JSON.stringify(
      {
        model: openaiRequest.model,
        systemIncluded: Boolean(aisdkParams.system),
        promptPreview:
          typeof aisdkParams.prompt === "string"
            ? truncate(aisdkParams.prompt, 200)
            : undefined,
        toolNames: Object.keys(aisdkParams.tools ?? {}),
        temperature: aisdkParams.temperature,
        maxTokens: aisdkParams.maxTokens,
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

  constructor(config: ProxyConfig) {
    this.config = {
      port: 3000,
      host: "localhost",
      cors: true,
      ...config,
    };

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
          console.error("Request handling error:", error);
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
      const result = await streamText({
        model: this.config.model,
        ...aisdkParams,
      });

      for await (const chunk of result.fullStream) {
        const openaiChunks = convertAISDKStreamChunkToOpenAI(
          chunk,
          openaiRequest.model
        );

        for (const openaiChunk of openaiChunks) {
          reply.raw.write(`data: ${openaiChunk.data}\n\n`);
        }
      }

      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (error) {
      console.error("Streaming error:", error);
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
      const result = await generateText({
        model: this.config.model,
        ...aisdkParams,
      });

      const openaiResponse = convertAISDKResultToOpenAI(
        result,
        openaiRequest.model,
        false
      );

      reply.send(openaiResponse);
    } catch (error) {
      console.error("Generation error:", error);
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

      console.log(
        `🚀 OpenAI Proxy Server running on http://${this.config.host}:${this.config.port}`
      );
      console.log(
        `📡 Endpoint: http://${this.config.host}:${this.config.port}/v1/chat/completions`
      );
      console.log(
        `🏥 Health: http://${this.config.host}:${this.config.port}/health`
      );
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.fastify.close();
      console.log("🛑 Server stopped");
    } catch (error) {
      console.error("Error stopping server:", error);
    }
  }
}
