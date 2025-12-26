import { describe, it } from "vitest";
import { z } from "zod";

import { parse } from "../..";

describe("html related", () => {
  it("todo_1", () => {
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

    const schema = z.toJSONSchema(
      z.object({
        path: z.string(),
        content: z.string(),
      })
    );

    const result = parse(xml, schema);
    console.log(result.content);
  });

  it("todo_2", () => {
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

    const schema = z.toJSONSchema(
      z.object({
        path: z.string(),
        content: z.string(),
      })
    );

    const result = parse(xml, schema);
    console.log(result.content);
  });
});
