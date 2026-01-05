import { beforeEach, describe, expect, it } from "vitest";
import { globalMethodRegistry } from "./method-registry";
import { SafeExecutor, type ToolCall } from "./safe-executor";

const ROOT_PATH_REGEX = /^\/+$/;

describe("SafeExecutor", () => {
  describe("parsePythonCall", () => {
    it("should parse simple function call with keyword args", () => {
      const result = SafeExecutor.parsePythonCall(
        "mv(source='file.txt', destination='backup/file.txt')"
      );
      expect(result).toEqual({
        toolName: "mv",
        args: {
          source: "file.txt",
          destination: "backup/file.txt",
        },
      });
    });

    it("should parse function call with positional args", () => {
      const result = SafeExecutor.parsePythonCall("cd('documents')");
      expect(result).toEqual({
        toolName: "cd",
        args: {
          folder: "documents",
        },
      });
    });

    it("should parse function call with no args", () => {
      const result = SafeExecutor.parsePythonCall("pwd()");
      expect(result).toEqual({
        toolName: "pwd",
        args: {},
      });
    });

    it("should parse function call with list argument", () => {
      const result = SafeExecutor.parsePythonCall("mean(numbers=[1, 2, 3, 4])");
      expect(result).toEqual({
        toolName: "mean",
        args: {
          numbers: [1, 2, 3, 4],
        },
      });
    });

    it("should parse function call with dict argument", () => {
      const result = SafeExecutor.parsePythonCall(
        "edit_ticket(ticket_id=1, updates={'priority': 'high'})"
      );
      expect(result).toEqual({
        toolName: "edit_ticket",
        args: {
          ticket_id: 1,
          updates: { priority: "high" },
        },
      });
    });

    it("should handle escaped characters in strings", () => {
      const result = SafeExecutor.parsePythonCall(
        "echo(content='line1\\nline2', file_name='test.txt')"
      );
      expect(result).toEqual({
        toolName: "echo",
        args: {
          content: "line1\nline2",
          file_name: "test.txt",
        },
      });
    });

    it("should parse method with class prefix", () => {
      const result = SafeExecutor.parsePythonCall(
        "GorillaFileSystem.mkdir(dir_name='new_folder')"
      );
      expect(result).toEqual({
        toolName: "mkdir",
        args: {
          dir_name: "new_folder",
        },
      });
    });

    it("should parse boolean values", () => {
      const result = SafeExecutor.parsePythonCall("ls(a=True)");
      expect(result).toEqual({
        toolName: "ls",
        args: {
          a: true,
        },
      });
    });

    it("should parse numeric values", () => {
      const result = SafeExecutor.parsePythonCall(
        "tail(file_name='log.txt', lines=100)"
      );
      expect(result).toEqual({
        toolName: "tail",
        args: {
          file_name: "log.txt",
          lines: 100,
        },
      });
    });
  });

  describe("execute", () => {
    beforeEach(() => {
      globalMethodRegistry.reset();
      globalMethodRegistry.getOrCreateInstance(
        "GorillaFileSystem",
        "test",
        "testModel",
        {},
        false,
        false
      );
    });

    it("should execute mkdir command", async () => {
      const toolCall: ToolCall = {
        toolName: "mkdir",
        args: { dir_name: "test_folder" },
      };

      const result = await SafeExecutor.execute(toolCall);
      expect(result.success).toBe(true);

      const cdResult = await SafeExecutor.execute({
        toolName: "cd",
        args: { folder: "test_folder" },
      });
      expect(cdResult.success).toBe(true);
    });

    it("should execute touch and cat commands", async () => {
      const touchCall: ToolCall = {
        toolName: "touch",
        args: { file_name: "test.txt" },
      };
      await SafeExecutor.execute(touchCall);

      const echoCall: ToolCall = {
        toolName: "echo",
        args: { content: "hello world", file_name: "test.txt" },
      };
      await SafeExecutor.execute(echoCall);

      const catCall: ToolCall = {
        toolName: "cat",
        args: { file_name: "test.txt" },
      };
      const catResult = await SafeExecutor.execute(catCall);
      expect(catResult.success).toBe(true);
      expect((catResult.result as { file_content: string }).file_content).toBe(
        "hello world"
      );
    });

    it("should execute pwd command", async () => {
      const result = await SafeExecutor.execute({
        toolName: "pwd",
        args: {},
      });
      expect(result.success).toBe(true);
      expect(
        (result.result as { current_working_directory: string })
          .current_working_directory
      ).toMatch(ROOT_PATH_REGEX);
    });

    it("should block dangerous methods", async () => {
      const result = await SafeExecutor.execute({
        toolName: "eval",
        args: { code: "malicious" },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Dangerous method blocked");
    });

    it("should handle method not found", async () => {
      const result = await SafeExecutor.execute({
        toolName: "nonexistent_method",
        args: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Instance not found");
    });
  });

  describe("executeMany", () => {
    beforeEach(() => {
      globalMethodRegistry.reset();
      globalMethodRegistry.getOrCreateInstance(
        "GorillaFileSystem",
        "test",
        "testModel",
        {},
        false,
        false
      );
    });

    it("should execute multiple commands in sequence", async () => {
      const toolCalls: ToolCall[] = [
        { toolName: "mkdir", args: { dir_name: "project" } },
        { toolName: "cd", args: { folder: "project" } },
        { toolName: "touch", args: { file_name: "README.md" } },
        { toolName: "pwd", args: {} },
      ];

      const results = await SafeExecutor.executeMany(toolCalls);

      expect(results).toHaveLength(4);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);
      expect(results[3].success).toBe(true);
      expect(
        (results[3].result as { current_working_directory: string })
          .current_working_directory
      ).toContain("project");
    });
  });

  describe("serializeResult", () => {
    it("should serialize null as None", () => {
      expect(SafeExecutor.serializeResult(null)).toBe("None");
    });

    it("should serialize undefined as None", () => {
      expect(SafeExecutor.serializeResult(undefined)).toBe("None");
    });

    it("should return string as-is", () => {
      expect(SafeExecutor.serializeResult("hello")).toBe("hello");
    });

    it("should serialize objects to JSON", () => {
      expect(SafeExecutor.serializeResult({ a: 1 })).toBe('{"a":1}');
    });

    it("should serialize arrays to JSON", () => {
      expect(SafeExecutor.serializeResult([1, 2, 3])).toBe("[1,2,3]");
    });
  });
});
