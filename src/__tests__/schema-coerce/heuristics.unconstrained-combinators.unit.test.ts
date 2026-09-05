import { describe, expect, it } from "vitest";
import type { RxmlValue } from "../../rxml/builders/stringify";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
  ToolInputSchemaDefinition,
} from "../../schema/tool-input-schema";
import { coerceBySchema } from "../../schema-coerce";

interface CombinatorCase {
  readonly expected: RxmlValue;
  readonly input: RxmlValue;
  readonly name: string;
  readonly schema: ToolInputSchemaCandidate;
}

function strictObject(property: string): ToolInputSchema {
  return {
    type: "object",
    properties: { [property]: { type: "string" } },
    additionalProperties: false,
  };
}

function arraySchema(items: ToolInputSchemaDefinition): ToolInputSchema {
  return { type: "array", items };
}

const nullItems: ToolInputSchemaCandidate = null;
const arrayWithNullItems: ToolInputSchemaCandidate = {
  type: "array",
  items: nullItems,
};
const wrapperWithId = { wrapper: { id: "1" } };
const unchangedIdWrapper = [{ wrapper: { id: "1" } }];
const combinatorCases: readonly CombinatorCase[] = [
  {
    name: "should not unwrap single key objects when anyOf has unconstrained branch (empty object)",
    input: wrapperWithId,
    schema: arraySchema({ anyOf: [{}, strictObject("id")] }),
    expected: unchangedIdWrapper,
  },
  {
    name: "should not unwrap single key objects when anyOf has unconstrained branch (true)",
    input: wrapperWithId,
    schema: arraySchema({ anyOf: [true, strictObject("id")] }),
    expected: unchangedIdWrapper,
  },
  {
    name: "should not unwrap single key objects when oneOf has unconstrained branch",
    input: { wrapper: { name: "test" } },
    schema: arraySchema({ oneOf: [{}, strictObject("name")] }),
    expected: [{ wrapper: { name: "test" } }],
  },
  {
    name: "should not unwrap single key objects when allOf has unconstrained branch",
    input: { wrapper: { value: "42" } },
    schema: arraySchema({ allOf: [{}, { type: "object" }] }),
    expected: [{ wrapper: { value: "42" } }],
  },
  {
    name: "should unwrap when all combinator branches disallow the wrapper key",
    input: wrapperWithId,
    schema: arraySchema({
      anyOf: [strictObject("id"), strictObject("name")],
    }),
    expected: [{ id: "1" }],
  },
  {
    name: "should not unwrap when items schema is unconstrained (null)",
    input: wrapperWithId,
    schema: arrayWithNullItems,
    expected: unchangedIdWrapper,
  },
  {
    name: "should not unwrap when items schema is unconstrained (empty object)",
    input: wrapperWithId,
    schema: arraySchema({}),
    expected: unchangedIdWrapper,
  },
  {
    name: "should not unwrap when items schema is boolean true",
    input: wrapperWithId,
    schema: arraySchema(true),
    expected: unchangedIdWrapper,
  },
];

describe("Coercion Heuristic Handling", () => {
  describe("Unconstrained schema handling in combinators", () => {
    for (const testCase of combinatorCases) {
      it(testCase.name, () => {
        expect(coerceBySchema(testCase.input, testCase.schema)).toEqual(
          testCase.expected
        );
      });
    }
  });
});
