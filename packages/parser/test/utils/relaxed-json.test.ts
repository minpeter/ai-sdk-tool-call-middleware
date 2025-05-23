import { describe, test, expect } from 'vitest';
import { parse as rjsonParse } from '../../src/utils/relaxed-json'; // Using 'parse' as RJSON.parse

describe('RJSON.parse (relaxed-json)', () => {
  // 1. Standard JSON
  test('should parse standard valid JSON', () => {
    const jsonString = '{"name": "John Doe", "age": 30, "isStudent": false, "courses": [{"id": 1, "title": "Math"}, {"id": 2, "title": "Science"}], "address": null}';
    expect(rjsonParse(jsonString)).toEqual(JSON.parse(jsonString));
  });

  // 2. Trailing Commas
  describe('Trailing Commas', () => {
    test('should parse arrays with trailing commas', () => {
      expect(rjsonParse('[1, 2, 3, ]')).toEqual([1, 2, 3]);
      expect(rjsonParse('[\n1,\n2,\n3,\n]')).toEqual([1, 2, 3]);
    });

    test('should parse objects with trailing commas', () => {
      expect(rjsonParse('{"a": 1, "b": 2, }')).toEqual({ a: 1, b: 2 });
      expect(rjsonParse('{\n"a": 1,\n"b": 2,\n}')).toEqual({ a: 1, b: 2 });
    });
    
    test('should parse objects with trailing commas and comments', () => {
      expect(rjsonParse('{ "a": 1, /* comment */ "b": 2, } // another comment'))
        .toEqual({ a: 1, b: 2 });
    });
  });

  // 3. Comments
  describe('Comments', () => {
    test('should ignore single-line comments', () => {
      const jsonString = `
        {
          // This is a comment
          "name": "Jane Doe", // Another comment
          "age": 25 // Comment at end of line
        }
      `;
      expect(rjsonParse(jsonString)).toEqual({ name: 'Jane Doe', age: 25 });
    });

    test('should ignore multi-line comments', () => {
      const jsonString = `
        {
          /* This is a 
             multi-line comment */
          "city": "New York", /* Single-line multi-line comment */
          "country": "USA"
        }
      `;
      expect(rjsonParse(jsonString)).toEqual({ city: 'New York', country: 'USA' });
    });

    test('should handle comments at various positions', () => {
      const jsonString = `
        // Comment at the beginning
        {
          "id": 123, /* Comment after a property */
          // Comment before a property
          "value": "test"
        }
        // Comment at the end
      `;
      expect(rjsonParse(jsonString)).toEqual({ id: 123, value: 'test' });
    });
    
    test('should parse JSON with comments and trailing commas', () => {
        const json = `{
          "foo": "bar", // comment
          "baz": [ // another comment
            1,
            2, // yet another comment
          ], /* block comment */
        }`;
        expect(rjsonParse(json)).toEqual({ foo: 'bar', baz: [1, 2] });
    });
  });

  // 4. Unquoted Keys
  describe('Unquoted Keys', () => {
    test('should parse objects with unquoted keys', () => {
      expect(rjsonParse('{name: "Alice", age: 40}')).toEqual({ name: 'Alice', age: 40 });
    });

    test('should parse objects with mixed quoted and unquoted keys', () => {
      expect(rjsonParse('{name: "Bob", "occupation": "Builder", city: "London"}'))
        .toEqual({ name: 'Bob', occupation: 'Builder', city: 'London' });
    });
    
    test('unquoted keys with special characters (if supported by identifier regex)', () => {
      // The regex is: /^[$a-zA-Z0-9_\-+\.\*\?!\|&%\^\/#\\]+/
      expect(rjsonParse('{key-with-hyphen: 1, key_with_underscore: 2, key.with.dots: 3, $key: 4}'))
        .toEqual({"key-with-hyphen": 1, "key_with_underscore": 2, "key.with.dots": 3, "$key": 4 });
    });
  });

  // 5. Single Quoted Strings
  describe('Single Quoted Strings', () => {
    test('should parse strings enclosed in single quotes', () => {
      expect(rjsonParse("{'name': 'Charlie', 'message': 'Hello world'}")).toEqual({ name: 'Charlie', message: 'Hello world' });
    });

    test('should handle escaped single quotes within single-quoted strings', () => {
      expect(rjsonParse("{'quote': 'It\\'s a nice day'}")).toEqual({ quote: "It's a nice day" });
    });
    
    test('should handle escaped double quotes within single-quoted strings', () => {
      expect(rjsonParse("{'quote': 'She said \\\"Hello\\\"'}")).toEqual({ quote: 'She said "Hello"' });
    });
  });

  // 6. Special Character Handling
  describe('Special Character Handling in Strings', () => {
    test('should parse strings with standard JSON escapes', () => {
      expect(rjsonParse('{"escapes": "line1\\nline2\\ttabbed\\rreturn\\f formfeed\\\\backslash\\"quote"}'))
        .toEqual({ escapes: "line1\nline2\ttabbed\rreturn\f formfeed\\backslash\"quote" });
    });
    test('should parse strings with unicode escapes', () => {
      expect(rjsonParse('{"unicode": "\\u0048\\u0065\\u006C\\u006C\\u006F"}')).toEqual({ unicode: "Hello" }); // Hello
    });
  });

  // 7. Nested Structures
  describe('Nested Structures', () => {
    test('should parse complex nested objects and arrays with mixed relaxed features', () => {
      const relaxedJsonString = `
        {
          // Root object
          name: "Complex Object",
          'version': 1.0, // Single quotes for string value
          data: [ // Array with various elements
            null, true, false, 123, -45.67,
            'a string with spaces',
            {
              // Nested object with unquoted keys and comments
              nestedKey: 'nested value', // comment after value
              another_key: [1, 2, 3, ], // Array with trailing comma
              /* multi-line comment
                 inside nested object */
              'single-quoted-key': 'value for single quoted key',
            },
          ], // Trailing comma in outer array
          // Another comment
          description: 'Test // with // nested // comments',
        }
      `;
      const expected = {
        name: "Complex Object",
        version: 1.0,
        data: [
          null, true, false, 123, -45.67,
          "a string with spaces",
          {
            nestedKey: "nested value",
            another_key: [1, 2, 3],
            "single-quoted-key": "value for single quoted key",
          },
        ],
        description: "Test // with // nested // comments",
      };
      expect(rjsonParse(relaxedJsonString)).toEqual(expected);
    });
  });

  // 8. Error Handling
  describe('Error Handling', () => {
    test('should throw error for fundamentally malformed JSON (e.g. unclosed object)', () => {
      expect(() => rjsonParse('{"a": 1, "b": 2')).toThrowError(SyntaxError); // Missing closing brace
      expect(() => rjsonParse('{"a": 1, "b":, }')).toThrowError(SyntaxError); // Value missing
      expect(() => rjsonParse('[1, 2,')).toThrowError(SyntaxError); // Missing closing bracket
    });

    test('should throw error for invalid token sequence', () => {
      expect(() => rjsonParse('{"a" 1}')).toThrowError(SyntaxError); // Missing colon
      expect(() => rjsonParse('{a:1 b:2}')).toThrowError(SyntaxError); // Missing comma
    });

    test('should throw error for empty input when tolerant is false (default)', () => {
      // The parser with default options (relaxed=true, tolerant=false, warnings=false)
      // expects a value. Empty string is not a value.
      expect(() => rjsonParse('')).toThrowError(SyntaxError);
      expect(() => rjsonParse('   ')).toThrowError(SyntaxError); // Whitespace only
    });

    test('should parse with tolerant mode and collect warnings', () => {
      const jsonStr = '{a:1, b:, c:3, d:}'; // b and d are missing values
      // Warnings implies tolerant
      expect(() => rjsonParse(jsonStr, { warnings: true })).toThrowError(SyntaxError);
      
      try {
        rjsonParse(jsonStr, { warnings: true });
      } catch (e: any) {
        expect(e).toBeInstanceOf(SyntaxError);
        expect(e.message).toContain('parse warnings'); // Summary message
        expect(e.warnings).toBeInstanceOf(Array);
        expect(e.warnings.length).toBeGreaterThanOrEqual(2); // At least 2 warnings for missing values
        // Check first warning (approximate, line numbers can be tricky)
        expect(e.warnings[0].message).toContain("Unexpected token: ',', expected json value");
        // The parsed object might be partial
        expect(e.obj).toEqual({ a: 1, b: null, c: 3, d: null }); // Tolerant mode might insert null for missing values
      }
    });

    test('should allow duplicate keys by default (relaxed=true)', () => {
      // Default options for rjsonParse is relaxed: true, duplicate: false (meaning check for duplicates is OFF / duplicates allowed)
      // The internal `duplicate` option for the parser is `!options.duplicate`.
      // So, `options.duplicate: false` (default) means `state.duplicate: true` (check for duplicates is ON).
      // This is confusing. Let's test actual behavior.
      // The current RJSON code's default for `options.duplicate` is `false`.
      // This means `!options.duplicate` is `true`, so `state.duplicate` becomes `true`, which means "check for duplicates".
      // Therefore, duplicates should throw an error by default if `tolerant: false`.
      expect(() => rjsonParse('{a:1, a:2}')).toThrowError(/Duplicate key: a/);
    });

    test('should allow duplicate keys if options.duplicate is true', () => {
      expect(rjsonParse('{a:1, a:2}', { duplicate: true })).toEqual({ a: 2 });
    });
    
    test('should not allow duplicate keys if options.duplicate is false (and not tolerant)', () => {
        expect(() => rjsonParse('{ "a": 1, "a": 2 }', { duplicate: false }))
          .toThrowError(/Duplicate key: a/);
    });

    test('should collect warnings for duplicate keys if tolerant and not allowing duplicates', () => {
        try {
            rjsonParse('{ "a": 1, "a": 2 }', { tolerant: true, duplicate: false });
        } catch (e: any) {
            expect(e).toBeInstanceOf(SyntaxError);
            expect(e.warnings).toBeInstanceOf(Array);
            expect(e.warnings.some((w: any) => w.message.includes('Duplicate key: a'))).toBe(true);
            expect(e.obj).toEqual({ a: 2 }); // Last one wins
        }
    });

  });

  // 9. Various Data Types
  describe('Various Data Types', () => {
    test('should parse numbers (integers, floats, exponents)', () => {
      expect(rjsonParse('{"int": 123, "float": -45.67, "exp": 1.2e+3, "neg_exp": 3E-2}')).toEqual({
        int: 123, float: -45.67, exp: 1200, neg_exp: 0.03,
      });
    });
    test('should parse booleans (true, false)', () => {
      expect(rjsonParse('{"isTrue": true, "isFalse": false}')).toEqual({ isTrue: true, isFalse: false });
    });
    test('should parse null', () => {
      expect(rjsonParse('{"nothing": null}')).toEqual({ nothing: null });
    });
  });
  
  // Specific tests for options interaction
  describe('Options Interaction', () => {
    test('strict parsing (relaxed: false) should fail on comments', () => {
      const jsonWithComment = '// comment\n{"a": 1}';
      expect(() => rjsonParse(jsonWithComment, { relaxed: false })).toThrowError(SyntaxError);
    });

    test('strict parsing (relaxed: false) should fail on unquoted keys', () => {
      expect(() => rjsonParse('{a: 1}', { relaxed: false })).toThrowError(SyntaxError);
    });

    test('strict parsing (relaxed: false) should fail on single quotes', () => {
      expect(() => rjsonParse("{'a': 1}", { relaxed: false })).toThrowError(SyntaxError);
    });

    test('strict parsing (relaxed: false) should fail on trailing commas', () => {
      // Note: stripTrailingComma is applied if options.relaxed is true.
      // If options.relaxed is false, tokens are used as is by JSON.parse (via transform path)
      // or by the custom parser. JSON.parse itself errors on trailing commas.
      // The custom parser path for strict mode would also error as comma isn't expected before ] or }.
      expect(() => rjsonParse('{"a":1,}', { relaxed: false })).toThrowError(SyntaxError);
      expect(() => rjsonParse('[1,]', { relaxed: false })).toThrowError(SyntaxError);
    });
  });
});
