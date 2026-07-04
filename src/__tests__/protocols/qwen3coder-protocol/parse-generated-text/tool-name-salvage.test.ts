import { describe, expect, it } from "vitest";
import { extractQwen3CoderToolNameFromMarkup } from "../../../../core/protocols/qwen3coder-call-parsing";

describe("extractQwen3CoderToolNameFromMarkup: covers every inner call-tag shape the parser accepts", () => {
  describe("shorthand on each call tag name", () => {
    const callTagNames = ["function", "call", "tool", "invoke"] as const;

    for (const tag of callTagNames) {
      it(`salvages tool name from <${tag}="NAME">`, () => {
        expect(
          extractQwen3CoderToolNameFromMarkup(`<${tag}="alpha">body</${tag}>`)
        ).toBe("alpha");
      });

      it(`salvages tool name from <${tag}='NAME'>`, () => {
        expect(
          extractQwen3CoderToolNameFromMarkup(`<${tag}='beta'>body</${tag}>`)
        ).toBe("beta");
      });

      it(`salvages tool name from bare <${tag}=NAME>`, () => {
        expect(
          extractQwen3CoderToolNameFromMarkup(`<${tag}=gamma>body</${tag}>`)
        ).toBe("gamma");
      });

      it(`salvages tool name from <${tag} name="NAME">`, () => {
        expect(
          extractQwen3CoderToolNameFromMarkup(
            `<${tag} name="delta">body</${tag}>`
          )
        ).toBe("delta");
      });

      it(`salvages tool name from <${tag} name='NAME'>`, () => {
        expect(
          extractQwen3CoderToolNameFromMarkup(
            `<${tag} name='epsilon'>body</${tag}>`
          )
        ).toBe("epsilon");
      });
    }
  });

  describe("child-element name fallbacks", () => {
    it("does not treat data-name as the call name attribute", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          '<tool_call><function data-name="wrong"><name>right</name></function></tool_call>'
        )
      ).toBe("right");
    });

    it("salvages tool name from a <name>…</name> child when no attribute is present", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<tool_call><function><name>alpha</name></function></tool_call>"
        )
      ).toBe("alpha");
    });

    it("salvages tool name from a <tool_name>…</tool_name> child when no attribute is present", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<tool_call><function><tool_name>alpha</tool_name></function></tool_call>"
        )
      ).toBe("alpha");
    });

    it("salvages tool name from a <name> child even when the outer call tag has no name", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<tool_call><name>beta</name>garbage</tool_call>"
        )
      ).toBe("beta");
    });
  });

  describe("bare-shorthand character class matches the parser's accepted chars", () => {
    it("accepts hyphen", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<function=get-weather>body</function>"
        )
      ).toBe("get-weather");
    });

    it("does NOT include slash in bare shorthand (parser treats slash as tag terminator)", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<function=group/search>body</function>"
        )
      ).toBe("group");
    });

    it("accepts slash inside quoted shorthand (slash is valid inside quotes)", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          '<function="group/search">body</function>'
        )
      ).toBe("group/search");
    });

    it("accepts dotted names", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup("<function=a.b.c>body</function>")
      ).toBe("a.b.c");
    });

    it("accepts `=` inside bare shorthand values (parser's parseShorthandValue does)", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup("<function=a=b=c>body</function>")
      ).toBe("a=b=c");
    });

    it("accepts `'` inside bare shorthand values (parser's parseShorthandValue does)", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup("<function=a'b>body</function>")
      ).toBe("a'b");
    });

    it("accepts `\"` inside bare shorthand values (parser's parseShorthandValue does)", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup('<function=a"b>body</function>')
      ).toBe('a"b');
    });
  });

  describe("whitespace handling", () => {
    it("trims surrounding whitespace in attribute values", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          '<function="  alpha  ">body</function>'
        )
      ).toBe("alpha");
    });

    it("trims whitespace in child-element name", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup("<name>\n  alpha\n</name>")
      ).toBe("alpha");
    });

    it("accepts whitespace around the shorthand equals sign", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          '<function = "alpha">body</function>'
        )
      ).toBe("alpha");
    });

    it("trims surrounding whitespace around attribute names", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          '<function name="  alpha  ">body</function>'
        )
      ).toBe("alpha");
    });
  });

  describe("negative cases", () => {
    it("returns undefined when markup has no recognizable call tag", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup("<div>not a call</div>")
      ).toBeUndefined();
    });

    it("returns undefined for a nameless <function> with no name= and no child <name>", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<tool_call><function>garbage</function></tool_call>"
        )
      ).toBeUndefined();
    });

    it("returns undefined for an empty string", () => {
      expect(extractQwen3CoderToolNameFromMarkup("")).toBeUndefined();
    });

    it("returns undefined when the <name> child is empty", () => {
      expect(
        extractQwen3CoderToolNameFromMarkup(
          "<tool_call><function><name></name></function></tool_call>"
        )
      ).toBeUndefined();
    });
  });
});
