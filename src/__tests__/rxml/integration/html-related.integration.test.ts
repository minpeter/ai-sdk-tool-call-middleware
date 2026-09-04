import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parse } from "../../../rxml/parse";

const htmlFileSchema = z.toJSONSchema(
  z.object({
    path: z.string(),
    content: z.string(),
  })
);

interface HtmlFile {
  readonly content: string;
  readonly path: string;
}

function parseHtmlFile(xml: string): HtmlFile {
  const { path, content } = parse(xml, htmlFileSchema);
  if (typeof path !== "string" || typeof content !== "string") {
    throw new TypeError("Expected string path and HTML content");
  }
  return { path, content };
}

describe("html related", () => {
  it("preserves raw HTML doctype content inside string-typed field", () => {
    const xml = `
<file_write>
  <path>
    test.html
  </path>

  <content>
    <!DOCTYPE html>
    <html>
    <head>
      <title>Test HTML</title>
    </head>
    <body>
      <h1>This is a test HTML file.</h1>
      <p>Hello, world!</p>
    </body>
    </html>
  </content>
</file_write>
`;

    const result = parseHtmlFile(xml);

    expect(result.path.trim()).toBe("test.html");
    expect(result.content).toContain("<!DOCTYPE html>");
    expect(result.content).toContain("<h1>This is a test HTML file.</h1>");
  });

  it("decodes escaped HTML entities within content field", () => {
    const xml = `
<file_write><path>test.html</path><content>&lt;!DOCTYPE html&gt;
&lt;html&gt;
&lt;head&gt;
&lt;title&gt;Test Page&lt;/title&gt;
&lt;/head&gt;
&lt;body&gt;
&lt;h1&gt;Hello, world!&lt;/h1&gt;
&lt;/body&gt;
&lt;/html&gt;</content></file_write>
`;

    const result = parseHtmlFile(xml);

    expect(result.path).toBe("test.html");
    expect(result.content).toContain("<!DOCTYPE html>");
    expect(result.content).toContain("<title>Test Page</title>");
    expect(result.content).toContain("<h1>Hello, world!</h1>");
  });
});
