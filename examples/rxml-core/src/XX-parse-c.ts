import { parse } from "@ai-sdk-tool/rxml";
import { z } from "zod";

const schema = z.toJSONSchema(
  z.object({
    file_write: z.object({
      path: z.string(),
      content: z.string(),
    }),
  })
);

const c_code = [
  "#include <stdio.h>",
  "int main() {",
  '  printf("Hello, world!\\n");',
  "  return 0;",
  "}",
];

const text = [
  "<file_write>",
  "<path>test.c</path>",
  "<content>",
  c_code.join("\n"),
  "</content>",
  "</file_write>",
];

const result = parse(text.join("\n"), schema);

console.log(result);
