import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createToolMiddleware,
  type TCMToolDefinition,
  xmlProtocol,
} from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  generateText,
  jsonSchema,
  tool,
  wrapLanguageModel,
} from "ai";

// Load system prompt
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

const customMorphXmlMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools: TCMToolDefinition[]) {
    const toolsString = JSON.stringify(tools);
    return systemPromptTemplate.replace(/\$\{tools\}/g, toolsString);
  },
});

// Friendli API
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// GLM-4.6
const glm = wrapLanguageModel({
  model: friendli("zai-org/GLM-4.6"),
  middleware: [
    customMorphXmlMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

async function testSingleCase() {
  console.log("🔍 Testing Single ComplexFuncBench Case\n");

  // First test case from ComplexFuncBench
  const testMessage =
    "Today is October 13th, 2024. I want to rent a car for a day at the San Diego Marriott La Jolla. Could you compare the price differences for picking up the car at 8 AM tomorrow and the day after tomorrow?";

  const tools = {
    Search_Car_Location: tool({
      description: "Search for car rental locations based on location query.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Location to search for (e.g., 'San Diego Marriott La Jolla')",
          },
        },
        required: ["query"],
      }),
    }),
    Get_Car_Availabilities: tool({
      description:
        "Get available cars for a specific pickup location and time.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          location_id: {
            type: "string",
            description: "Location ID from search",
          },
          pickup_date: {
            type: "string",
            description: "Pickup date (YYYY-MM-DD)",
          },
          pickup_time: { type: "string", description: "Pickup time (HH:MM)" },
          dropoff_date: {
            type: "string",
            description: "Dropoff date (YYYY-MM-DD)",
          },
          dropoff_time: { type: "string", description: "Dropoff time (HH:MM)" },
        },
        required: [
          "location_id",
          "pickup_date",
          "pickup_time",
          "dropoff_date",
          "dropoff_time",
        ],
      }),
    }),
    Get_Car_Price: tool({
      description: "Get price for a specific car rental.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          car_id: { type: "string", description: "Car ID from availability" },
          location_id: { type: "string", description: "Location ID" },
          pickup_date: { type: "string", description: "Pickup date" },
          dropoff_date: { type: "string", description: "Dropoff date" },
        },
        required: ["car_id", "location_id", "pickup_date", "dropoff_date"],
      }),
    }),
  };

  console.log("Test Message:", testMessage);
  console.log("\nAvailable Tools:", Object.keys(tools).join(", "));
  console.log(`\n${"=".repeat(80)}`);
  console.log("GENERATING RESPONSE...\n");

  try {
    const result = await generateText({
      model: glm,
      prompt: testMessage,
      tools,
      maxOutputTokens: 1024,
    });

    console.log("=".repeat(80));
    console.log("RESULTS\n");
    console.log("Text:", result.text);
    console.log("\nTool Calls Count:", result.toolCalls.length);
    console.log("\nTool Calls:", JSON.stringify(result.toolCalls, null, 2));
    console.log("\nFinish Reason:", result.finishReason);

    // Check for middleware debug info
    console.log(`\n${"=".repeat(80)}`);
    console.log("RAW MODEL OUTPUT (if available)\n");

    const rawResponse = result.response as unknown as {
      messages?: Array<{ role: string; content?: string }>;
    };
    if (rawResponse?.messages) {
      for (const msg of rawResponse.messages) {
        if (msg.role === "assistant") {
          console.log("Assistant Message:");
          console.log(msg.content || JSON.stringify(msg, null, 2));
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

testSingleCase();
