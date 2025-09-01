import { parse } from "@ai-sdk-tool/rxml";
import { z } from "zod";

const schema = z.object({
  file_write: z.object({
    path: z.string(),
    content: z.string(),
  }),
});

const text = `<file_write>\n<path>\ntest.c\n</path>\n<content>\n#include <stdio.h>\n\nint main() {\n  printf(\"Hello, world!\\n\");\n  return 0;\n}\n</content>\n</file_write>`;

const result = parse(text, schema);

console.log(result);
