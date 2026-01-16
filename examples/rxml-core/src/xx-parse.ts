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

const text = `  <path>test.c</path>
  <content>#include <stdio.h>

int main() {
    printf("Hello, World!\\n");
    return 0;
}</content>`;
const result = parse(text, schema);

console.log(result);
