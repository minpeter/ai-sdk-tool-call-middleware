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

const py_code = [
  "import os",
  "def write_file(path, content):",
  "  with open(path, 'w') as f:",
  "    f.write(content)",
  "  if f.closed:",
  "    return 'success'",
  "  else:",
  "    return 'error'",
  "",
  "write_file('test.py', \"print('Hello, world!')\\nreturn 'success'\")",
  "print('Hello, world!')",
  "",
  "return 'success'",
];

const langs = [c_code, py_code];

for (const lang of langs) {
  const text = [
    "<file_write>",
    "<path>test.c</path>",
    "<content>",
    lang.join("\n"),
    "</content>",
    "</file_write>",
  ];
  const result = parse(text.join("\n"), schema);

  console.log(result);
}
