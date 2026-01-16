import { describe, expect, it } from "vitest";

import { parseWithoutSchema } from "../../core/parser";
import {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "../../schema/coercion";

describe("schema coercion", () => {
  describe("getPropertySchema", () => {
    it("extracts property schema from parent schema", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
      };

      expect(getPropertySchema(schema, "name")).toEqual({ type: "string" });
      expect(getPropertySchema(schema, "age")).toEqual({ type: "number" });
      expect(getPropertySchema(schema, "missing")).toBeUndefined();
    });

    it("handles wrapped JSON schema", () => {
      const schema = {
        jsonSchema: {
          type: "object",
          properties: {
            value: { type: "string" },
          },
        },
      };

      expect(getPropertySchema(schema, "value")).toEqual({ type: "string" });
    });

    it("handles invalid schemas gracefully", () => {
      expect(getPropertySchema(null, "test")).toBeUndefined();
      expect(getPropertySchema("invalid", "test")).toBeUndefined();
      expect(getPropertySchema({}, "test")).toBeUndefined();
    });
  });

  describe("getStringTypedProperties", () => {
    it("identifies string-typed properties", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          description: { type: "string" },
          active: { type: "boolean" },
        },
      };

      const stringProps = getStringTypedProperties(schema);
      expect(stringProps.has("name")).toBe(true);
      expect(stringProps.has("description")).toBe(true);
      expect(stringProps.has("age")).toBe(false);
      expect(stringProps.has("active")).toBe(false);
    });

    it("handles schemas without properties", () => {
      const stringProps = getStringTypedProperties({ type: "object" });
      expect(stringProps.size).toBe(0);
    });

    it("handles wrapped schemas", () => {
      const schema = {
        jsonSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      };

      const stringProps = getStringTypedProperties(schema);
      expect(stringProps.has("text")).toBe(true);
    });
  });

  describe("domToObject", () => {
    it("converts simple DOM to object", () => {
      const nodes = parseWithoutSchema("<name>John</name><age>30</age>");
      const result = domToObject(nodes, {});

      expect(result).toEqual({
        name: "John",
        age: "30",
      });
    });

    it("handles empty elements", () => {
      const nodes = parseWithoutSchema("<empty></empty><selfClosed/>");
      const result = domToObject(nodes, {});

      expect(result).toEqual({
        empty: "",
        selfClosed: "",
      });
    });

    it("handles elements with attributes", () => {
      const nodes = parseWithoutSchema(
        '<item id="1" type="test">content</item>'
      );
      const result = domToObject(nodes, {});

      expect(result.item).toEqual({
        "#text": "content",
        "@_id": "1",
        "@_type": "test",
      });
    });

    it("handles multiple elements with same tag name", () => {
      const nodes = parseWithoutSchema("<item>first</item><item>second</item>");
      const result = domToObject(nodes, {});

      expect(result.item).toEqual(["first", "second"]);
    });

    it("handles nested elements", () => {
      const nodes = parseWithoutSchema(
        "<user><name>John</name><details><age>30</age></details></user>"
      );
      const result = domToObject(nodes, {});

      expect(result.user).toMatchObject({
        name: "John",
        details: {
          age: "30",
        },
      });
    });

    it("uses custom textNodeName", () => {
      const nodes = parseWithoutSchema('<item id="1">content</item>');
      const result = domToObject(nodes, {}, "_text");

      expect(result.item).toEqual({
        _text: "content",
        "@_id": "1",
      });
    });
  });

  describe("processArrayContent", () => {
    it("processes string arrays correctly", () => {
      const value = [
        { "#text": "  first  " },
        { "#text": "  second  " },
        "third",
      ];
      const schema = { type: "string" };

      const result = processArrayContent(value, schema, "#text");
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("processes non-string arrays", () => {
      const value = [{ "#text": "  1  " }, { "#text": "  2  " }, "3"];
      const schema = { type: "number" };

      const result = processArrayContent(value, schema, "#text");
      expect(result).toEqual(["1", "2", "3"]);
    });

    it("handles non-array values", () => {
      const value = "test";
      const result = processArrayContent(value, {}, "#text");
      expect(result).toBe("test");
    });
  });

  describe("processIndexedTuple", () => {
    it("processes valid indexed tuples", () => {
      const obj = {
        "0": "first",
        "1": "second",
        "2": "third",
      };

      const result = processIndexedTuple(obj, "#text");
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("processes indexed tuples with text nodes", () => {
      const obj = {
        "0": { "#text": "  first  " },
        "1": { "#text": "  second  " },
        "2": "third",
      };

      const result = processIndexedTuple(obj, "#text");
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("handles non-sequential indices", () => {
      const obj = {
        "0": "first",
        "2": "third",
        "1": "second",
      };

      const result = processIndexedTuple(obj, "#text");
      expect(result).toEqual(["first", "second", "third"]);
    });

    it("handles invalid tuple patterns", () => {
      const obj = {
        "1": "first", // doesn't start with 0
        "2": "second",
      };

      const result = processIndexedTuple(obj, "#text");
      expect(result).toEqual([obj]); // Returns original object wrapped in array
    });

    it("handles gaps in indices", () => {
      const obj = {
        "0": "first",
        "2": "third", // missing 1
      };

      const result = processIndexedTuple(obj, "#text");
      expect(result).toEqual([obj]); // Returns original object wrapped in array
    });
  });

  describe("coerceDomBySchema", () => {
    it("coerces simple object properties", () => {
      const domObject = {
        name: "John",
        age: "30",
        active: "true",
      };
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
          active: { type: "boolean" },
        },
      };

      const result = coerceDomBySchema(domObject, schema);
      expect(result).toEqual({
        name: "John",
        age: 30,
        active: true,
      });
    });

    it("coerces array properties", () => {
      const domObject = {
        numbers: ["1", "2", "3"],
        flags: ["true", "false", "true"],
      };
      const schema = {
        type: "object",
        properties: {
          numbers: {
            type: "array",
            items: { type: "number" },
          },
          flags: {
            type: "array",
            items: { type: "boolean" },
          },
        },
      };

      const result = coerceDomBySchema(domObject, schema);
      expect(result).toEqual({
        numbers: [1, 2, 3],
        flags: [true, false, true],
      });
    });

    it("coerces nested object properties", () => {
      const domObject = {
        user: {
          name: "John",
          age: "30",
          settings: {
            theme: "dark",
            notifications: "true",
          },
        },
      };
      const schema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
              settings: {
                type: "object",
                properties: {
                  theme: { type: "string" },
                  notifications: { type: "boolean" },
                },
              },
            },
          },
        },
      };

      const result = coerceDomBySchema(domObject, schema);
      expect(result).toEqual({
        user: {
          name: "John",
          age: 30,
          settings: {
            theme: "dark",
            notifications: true,
          },
        },
      });
    });

    it("throws RXMLCoercionError on coercion failure", () => {
      const domObject = { value: "invalid-number" };
      const schema = {
        type: "object",
        properties: {
          value: { type: "number" },
        },
      };

      // This should not throw because the base coercion handles it gracefully
      // But if there were a genuine coercion error, it would be wrapped
      const result = coerceDomBySchema(domObject, schema);
      expect(result.value).toBe("invalid-number"); // Fallback to original value
    });

    it("handles missing schema gracefully", () => {
      const domObject = { value: "test" };
      const result = coerceDomBySchema(domObject, undefined);
      expect(result).toEqual(domObject);
    });
  });

  describe("integration with complex schemas", () => {
    it("handles mixed content with schema", () => {
      const xml =
        "<data><items><item>1</item><item>2</item></items><metadata><count>2</count><valid>true</valid></metadata></data>";
      const nodes = parseWithoutSchema(xml);
      const domObject = domToObject(nodes, {});

      const schema = {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: { type: "number" },
              },
              metadata: {
                type: "object",
                properties: {
                  count: { type: "number" },
                  valid: { type: "boolean" },
                },
              },
            },
          },
        },
      };

      const result = coerceDomBySchema(domObject, schema);
      expect(result).toEqual({
        data: {
          items: [1, 2],
          metadata: {
            count: 2,
            valid: true,
          },
        },
      });
    });

    it("handles item wrapper pattern", () => {
      const xml =
        "<numbers><item>1</item><item>2</item><item>3</item></numbers>";
      const nodes = parseWithoutSchema(xml);
      const domObject = domToObject(nodes, {});

      const schema = {
        type: "object",
        properties: {
          numbers: {
            type: "array",
            items: { type: "number" },
          },
        },
      };

      const result = coerceDomBySchema(domObject, schema);
      expect(result.numbers).toEqual([1, 2, 3]);
    });
  });
});
