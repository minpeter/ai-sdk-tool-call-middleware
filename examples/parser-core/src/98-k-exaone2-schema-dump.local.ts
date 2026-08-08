import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { z } from "zod";
import { kExaone2ToolMiddleware } from "../../../src/index";

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_API_KEY!,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const captureTransform = {
  specificationVersion: "v4" as const,
  transformParams: async ({ params }: { params: any }) => {
    const prompt = params.prompt ?? [];
    const systems = prompt.filter((m: any) => m.role === "system");
    const text = systems
      .map((m: any) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content)
      )
      .join("\n---\n");
    console.log("TOOLS_PARAM", JSON.stringify(params.tools));
    console.log("SYSTEM_LEN", text.length);
    console.log("SYSTEM_FULL_START");
    console.log(text.slice(0, 2500));
    console.log("SYSTEM_FULL_END");
    return params;
  },
};

async function main() {
  // outer kExaone2 transforms first; inner capture sees provider-bound params
  const model = wrapLanguageModel({
    model: wrapLanguageModel({
      model: friendli.chatModel("LGAI-EXAONE/K-EXAONE-2.0-750B-A37B"),
      middleware: captureTransform as any,
    }),
    middleware: kExaone2ToolMiddleware,
  });

  await generateText({
    model,
    maxOutputTokens: 32,
    temperature: 0,
    stopWhen: stepCountIs(1),
    tools: {
      search_catalog: {
        description: "Search product catalog with nested filters/sort/page.",
        inputSchema: z.object({
          q: z.string(),
          filters: z
            .object({ inStockOnly: z.boolean().optional() })
            .optional(),
          sort: z
            .object({
              field: z.enum(["price", "stock", "relevance"]),
              order: z.enum(["asc", "desc"]),
            })
            .optional(),
          page: z.object({
            limit: z.number().int().min(1).max(20).default(5),
            offset: z.number().int().min(0).default(0),
          }),
        }),
        execute: async () => ({ items: [] }),
      },
    },
    prompt:
      "Call search_catalog for outdoor gear in stock sorted by price asc limit 3.",
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
