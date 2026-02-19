import { Readable } from "node:stream";

export const CHUNK_SIZE = 7;

/**
 * Simulates LLM token-based streaming by splitting text into fixed-size chunks
 */
export function createChunkedStream(
  text: string,
  chunkSize: number = CHUNK_SIZE,
  _parseOptions?: any
): Readable {
  let position = 0;

  return new Readable({
    read() {
      if (position >= text.length) {
        this.push(null); // End of stream
        return;
      }

      const chunk = text.slice(position, position + chunkSize);
      position += chunk.length;

      // Push chunks immediately without delay for fast testing
      this.push(chunk);
    },
  });
}

/**
 * Test XML samples that represent typical LLM tool call responses
 */
export const testXmlSamples = {
  simple: `<tool_call>
  <name>get_weather</name>
  <parameters>
    <location>Seoul</location>
    <unit>celsius</unit>
  </parameters>
</tool_call>`,

  withAttributes: `<tool_call id="call_1" type="function">
  <name>calculate</name>
  <parameters>
    <operation>add</operation>
    <numbers>
      <item>10</item>
      <item>20</item>
      <item>30</item>
    </numbers>
  </parameters>
</tool_call>`,

  multipleTools: `<tools>
  <tool_call id="1">
    <name>search</name>
    <parameters>
      <query>AI research</query>
      <limit>5</limit>
    </parameters>
  </tool_call>
  <tool_call id="2">
    <name>summarize</name>
    <parameters>
      <text>Long text to summarize...</text>
      <max_length>100</max_length>
    </parameters>
  </tool_call>
</tools>`,

  withCdata: `<tool_call>
  <name>execute_code</name>
  <parameters>
    <language>python</language>
    <code><![CDATA[
def hello_world():
    print("Hello, World!")
    return "success"
]]></code>
  </parameters>
</tool_call>`,

  withComments: `<!-- Tool call response -->
<tool_call>
  <name>analyze_data</name>
  <!-- Parameters for analysis -->
  <parameters>
    <dataset>sales_data.csv</dataset>
    <method>regression</method>
  </parameters>
</tool_call>
<!-- End of response -->`,

  malformed: `<tool_call>
  <name>test_function</name>
  <parameters>
    <value>some content with <unclosed tag
    <another>properly closed</another>
  </parameters>
</tool_call>`,

  largeContent: `<tool_call>
  <name>process_large_data</name>
  <parameters>
    <data>${"x".repeat(500)}</data>
    <items>${Array.from({ length: 50 }, (_, i) => `<item id="${i}">Item ${i} content</item>`).join("")}</items>
  </parameters>
</tool_call>`,

  nestedStructure: `<response>
  <tool_calls>
    <tool_call>
      <name>get_user_info</name>
      <parameters>
        <user>
          <id>123</id>
          <profile>
            <name>John Doe</name>
            <email>john@example.com</email>
            <preferences>
              <theme>dark</theme>
              <language>en</language>
            </preferences>
          </profile>
        </user>
      </parameters>
    </tool_call>
  </tool_calls>
</response>`,
};
