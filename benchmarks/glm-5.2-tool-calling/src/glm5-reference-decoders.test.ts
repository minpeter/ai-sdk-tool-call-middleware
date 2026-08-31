import { describe, expect, it } from "vitest";
import {
  callsExactlyEqual,
  decodeProductionGlm5Generate,
  decodeProductionGlm5Stream,
  fixedWidthChunks,
} from "./glm5-parser-evaluation";
import {
  GLM5_REFERENCE_CORPUS,
  GLM5_REFERENCE_CORPUS_TOOLS,
} from "./glm5-reference-corpus";
import {
  decodeWithSglangGlm47Reference,
  decodeWithVllmGlm47Reference,
  decodeWithVllmPythonGlm47Reference,
  GLM5_REFERENCE_DECODER_SOURCES,
} from "./glm5-reference-decoders";

function corpusCase(id: string) {
  const testCase = GLM5_REFERENCE_CORPUS.find((item) => item.id === id);
  if (!testCase) {
    throw new Error(`Missing corpus case: ${id}`);
  }
  return testCase;
}

describe("pinned GLM deployment-reference decoders", () => {
  it("pins the exact vLLM Rust and SGLang source revisions and hashes", () => {
    expect(GLM5_REFERENCE_DECODER_SOURCES.vllm).toEqual({
      implementation: "vllm-rust-glm47-moe-deployment-reference",
      paths: [
        "rust/src/parser/src/tool/glm_xml/glm47_moe.rs",
        "rust/src/parser/src/tool/glm_xml/mod.rs",
      ],
      revision: "26c909ed74a6298952d0c3191fbfdf2b513d9e1d",
      sha256: [
        "c6ad055e23f0aaf976e1de105e6d3a152c6c04673926adb47577c5c8bf0d0147",
        "9792c1654ff17cba55897f805bc816a00aa13b89cbcc2c17f1fd02c1301f6ae8",
      ],
    });
    expect(GLM5_REFERENCE_DECODER_SOURCES.sglang.revision).toBe(
      "619609aa5a2c4859cee79e9dd16a15cf1ff4c98a"
    );
    expect(GLM5_REFERENCE_DECODER_SOURCES.sglang.sha256).toBe(
      "4ed06f8370249f6dafd91b5a25796851845a028a3ccc79efff2f68b6971a5af1"
    );
    expect(GLM5_REFERENCE_DECODER_SOURCES["vllm-python"]).toEqual({
      implementation: "vllm-python-glm47-moe-deployment-reference",
      path: "vllm/parser/glm47_moe.py",
      revision: "26c909ed74a6298952d0c3191fbfdf2b513d9e1d",
      sha256:
        "ce3629319e56e882d25cb75d62e3e7088a4eec1518885fc69fc696eafb4a97b2",
    });
  });

  it("reproduces vLLM Rust schema conversion and duplicate overwrite", () => {
    const canonical = corpusCase("canonical-number-coercion");
    const canonicalResult = decodeWithVllmGlm47Reference(
      canonical.text,
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    expect(canonicalResult.calls).toEqual(canonical.expectedCalls);

    const duplicate = corpusCase("duplicate-key");
    const duplicateResult = decodeWithVllmGlm47Reference(
      duplicate.text,
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    expect(duplicateResult.calls).toEqual([
      { arguments: { message: "second" }, name: "echo" },
    ]);
  });

  it("requires an exact complete outer close in both references", () => {
    const testCase = corpusCase("missing-tool-call-close");
    const vllm = decodeWithVllmGlm47Reference(
      testCase.text,
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    const sglang = decodeWithSglangGlm47Reference(
      testCase.text,
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    expect(vllm.calls).toEqual([]);
    expect(vllm.errors).toContain(
      "vLLM reference found <tool_call> without </tool_call>."
    );
    expect(sglang.calls).toEqual([]);
    expect(sglang.errors).toContain(
      "SGLang reference found <tool_call> without a complete outer close."
    );
    expect(
      decodeWithVllmPythonGlm47Reference(
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      ).calls
    ).toEqual([]);
  });

  it("keeps Python raw-string arguments separate from Rust schema conversion", () => {
    const testCase = corpusCase("canonical-number-coercion");
    expect(
      decodeWithVllmPythonGlm47Reference(
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      ).calls
    ).toEqual([{ arguments: { left: "7", right: "11" }, name: "add" }]);
  });

  it("keeps exact lowercase marker matching in both references", () => {
    const testCase = corpusCase("variant-tag-case");
    expect(
      decodeWithVllmGlm47Reference(testCase.text, GLM5_REFERENCE_CORPUS_TOOLS)
        .calls
    ).toEqual([]);
    expect(
      decodeWithSglangGlm47Reference(testCase.text, GLM5_REFERENCE_CORPUS_TOOLS)
        .calls
    ).toEqual([]);
  });

  it("reproduces SGLang JSON, Python-literal, and string fallbacks", () => {
    const text = [
      "<tool_call>aggregate",
      "<arg_key>items</arg_key><arg_value>[1, 2, 3]</arg_value>",
      "<arg_key>config</arg_key><arg_value>{'mode': 'safe', 'enabled': True}</arg_value>",
      "</tool_call>",
    ].join("");
    expect(
      decodeWithSglangGlm47Reference(text, GLM5_REFERENCE_CORPUS_TOOLS).calls
    ).toEqual([
      {
        arguments: {
          config: { enabled: true, mode: "safe" },
          items: [1, 2, 3],
        },
        name: "aggregate",
      },
    ]);
  });
});

describe("production parser comparison harness", () => {
  it.each([
    "variant-tag-case",
    "variant-tag-whitespace",
    "missing-tool-call-close",
    "raw-outer-close-in-string",
  ])("recovers the labeled custom-parser case %s", async (id) => {
    const testCase = corpusCase(id);
    const generated = decodeProductionGlm5Generate(
      testCase.text,
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    const streamed = await decodeProductionGlm5Stream(
      fixedWidthChunks(testCase.text, 1),
      GLM5_REFERENCE_CORPUS_TOOLS
    );
    expect(generated.calls).toEqual(testCase.expectedCalls);
    expect(streamed.calls).toEqual(testCase.expectedCalls);
    expect(callsExactlyEqual(generated.calls, streamed.calls)).toBe(true);
    expect(generated.text).toBe(streamed.text);
    if (id === "missing-tool-call-close") {
      expect(generated.errors).toEqual([]);
      expect(generated.recoveries.length).toBeGreaterThan(0);
      expect(streamed.errors).toEqual([]);
      expect(streamed.recoveries.length).toBeGreaterThan(0);
      const replayed = await decodeProductionGlm5Stream(
        fixedWidthChunks(testCase.text, 1),
        GLM5_REFERENCE_CORPUS_TOOLS
      );
      expect(streamed.recoveries).toEqual(replayed.recoveries);
      expect(streamed.recoveries.join("\n")).not.toContain("toolCallId");
    }
  });

  it.each(["duplicate-key", "prototype-sensitive-key", "unknown-tool"])(
    "fails closed for %s",
    async (id) => {
      const testCase = corpusCase(id);
      const generated = decodeProductionGlm5Generate(
        testCase.text,
        GLM5_REFERENCE_CORPUS_TOOLS
      );
      const streamed = await decodeProductionGlm5Stream(
        fixedWidthChunks(testCase.text, 7),
        GLM5_REFERENCE_CORPUS_TOOLS
      );
      expect(generated.calls).toEqual([]);
      expect(streamed.calls).toEqual([]);
    }
  );
});
