/**
 * SSE Chunk Inspector for testing OpenAI Proxy Server
 * Provides detailed analysis of Server-Sent Events chunks
 */

type SSEChunk = {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
};

type ParsedOpenAIChunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
};

export class SSEChunkInspector {
  private chunks: SSEChunk[] = [];
  private parsedChunks: ParsedOpenAIChunk[] = [];
  private textContent = "";
  private toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];

  /**
   * Parse raw SSE stream data
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SSE parsing requires multiple conditions
  parseSSEStream(rawData: string): void {
    const lines = rawData.split("\n");
    let currentChunk: Partial<SSEChunk> = {};

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine === "") {
        // Empty line indicates end of a chunk
        if (currentChunk.data) {
          this.chunks.push(currentChunk as SSEChunk);
          this.parseChunkData(currentChunk.data);
          currentChunk = {};
        }
        continue;
      }

      if (trimmedLine.startsWith("data: ")) {
        const data = trimmedLine.slice(6);
        if (data === "[DONE]") {
          console.log("🏁 Stream completed");
          return;
        }
        currentChunk.data = data;
      } else if (trimmedLine.startsWith("event: ")) {
        currentChunk.event = trimmedLine.slice(7);
      } else if (trimmedLine.startsWith("id: ")) {
        currentChunk.id = trimmedLine.slice(4);
      } else if (trimmedLine.startsWith("retry: ")) {
        currentChunk.retry = Number.parseInt(trimmedLine.slice(7), 10);
      }
    }
  }

  /**
   * Parse individual chunk data
   */
  private parseChunkData(data: string): void {
    try {
      const parsed = JSON.parse(data) as ParsedOpenAIChunk;
      this.parsedChunks.push(parsed);

      // Extract text content
      if (parsed.choices?.[0]?.delta?.content) {
        this.textContent += parsed.choices[0].delta.content;
      }

      // Extract tool calls
      if (parsed.choices?.[0]?.delta?.tool_calls) {
        // Handle tool call delta
        console.log(
          "🔧 Tool call delta detected:",
          parsed.choices[0].delta.tool_calls
        );
      }

      // Check finish reason
      if (parsed.choices?.[0]?.finish_reason) {
        console.log(
          `🏁 Stream finished with reason: ${parsed.choices[0].finish_reason}`
        );
      }
    } catch (error) {
      console.warn("⚠️ Failed to parse chunk data:", data, error);
    }
  }

  /**
   * Get detailed analysis report
   */
  getAnalysisReport(): {
    totalChunks: number;
    textContent: string;
    textLength: number;
    toolCalls: typeof this.toolCalls;
    parsedChunks: ParsedOpenAIChunk[];
    timeline: Array<{
      timestamp: number;
      chunkIndex: number;
      type: string;
      content?: string;
      finishReason?: string;
    }>;
  } {
    const timeline = this.parsedChunks.map((chunk, index) => ({
      timestamp: chunk.created,
      chunkIndex: index,
      type: chunk.object,
      content: chunk.choices?.[0]?.delta?.content,
      finishReason: chunk.choices?.[0]?.finish_reason,
    }));

    return {
      totalChunks: this.chunks.length,
      textContent: this.textContent,
      textLength: this.textContent.length,
      toolCalls: this.toolCalls,
      parsedChunks: this.parsedChunks,
      timeline,
    };
  }

  /**
   * Print detailed analysis to console
   */
  printAnalysis(): void {
    const report = this.getAnalysisReport();

    console.log("\n📊 SSE Chunk Analysis Report");
    console.log("=".repeat(50));
    console.log(`📦 Total chunks received: ${report.totalChunks}`);
    console.log(`📝 Text content length: ${report.textLength} characters`);
    console.log(`🔧 Tool calls detected: ${report.toolCalls.length}`);

    if (report.textContent) {
      console.log("\n📄 Complete Text Content:");
      console.log("─".repeat(30));
      console.log(report.textContent);
      console.log("─".repeat(30));
    }

    if (report.toolCalls.length > 0) {
      console.log("\n🔧 Tool Calls:");
      report.toolCalls.forEach((tool, index) => {
        console.log(`  ${index + 1}. ${tool.name}: ${tool.arguments}`);
      });
    }

    console.log("\n📈 Timeline:");
    // biome-ignore lint/complexity/noForEach: iterating over timeline entries
    for (const entry of report.timeline) {
      const timestamp = new Date(entry.timestamp * 1000).toISOString();
      if (entry.content) {
        console.log(
          `  ${timestamp} [${entry.chunkIndex}] 📝 Content: "${entry.content}"`
        );
      }
      if (entry.finishReason) {
        console.log(
          `  ${timestamp} [${entry.chunkIndex}] 🏁 Finished: ${entry.finishReason}`
        );
      }
    }
  }

  /**
   * Reset inspector state
   */
  reset(): void {
    this.chunks = [];
    this.parsedChunks = [];
    this.textContent = "";
    this.toolCalls = [];
  }
}

/**
 * Utility function to test SSE streaming
 */
export async function testSSEStreaming(
  url: string,
  // biome-ignore lint/suspicious/noExplicitAny: test utility for flexible request types
  request: any,
  inspector?: SSEChunkInspector
): Promise<void> {
  const chunkInspector = inspector || new SSEChunkInspector();

  try {
    console.log(`🚀 Starting SSE test to: ${url}`);
    console.log("📤 Request:", JSON.stringify(request, null, 2));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    console.log("✅ Connection established, receiving stream...");

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let rawData = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        rawData += chunk;

        // Process in real-time
        if (chunk.includes("\n\n")) {
          const completeChunk = rawData.split("\n\n")[0];
          chunkInspector.parseSSEStream(`${completeChunk}\n\n`);
          rawData = rawData.slice(completeChunk.length + 2);
        }
      }
    }

    chunkInspector.printAnalysis();
  } catch (error) {
    console.error("❌ SSE test failed:", error);
    throw error;
  }
}
