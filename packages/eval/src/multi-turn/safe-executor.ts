// Safe executor for method invocation
// Replaces Python's eval() with type-safe method calls

import { globalMethodRegistry } from "./method-registry";

export interface ExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
}

export class SafeExecutor {
  static METHOD_PARAMS: Record<string, string[]> = {
    cd: ["folder"],
    mkdir: ["dir_name"],
    touch: ["file_name"],
    echo: ["content", "file_name"],
    cat: ["file_name"],
    grep: ["file_name", "pattern"],
    sort: ["file_name"],
    tail: ["file_name", "lines"],
    diff: ["file_name1", "file_name2"],
    mv: ["source", "destination"],
    cp: ["source", "destination"],
    rm: ["file_name"],
    rmdir: ["dir_name"],
    find: ["path", "name"],
    ls: ["a"],
    pwd: [],
    wc: ["file_name", "mode"],
    du: ["human_readable"],
    authenticate_twitter: ["username", "password"],
    posting_get_login_status: [],
    post_tweet: ["content", "tags", "mentions"],
    retweet: ["tweet_id"],
    comment: ["tweet_id", "comment_content"],
    mention: ["tweet_id", "mentioned_usernames"],
    follow_user: ["username_to_follow"],
    list_all_following: [],
    unfollow_user: ["username_to_unfollow"],
    get_tweet: ["tweet_id"],
    get_user_tweets: ["username"],
    search_tweets: ["keyword"],
    get_tweet_comments: ["tweet_id"],
    get_user_stats: ["username"],
    create_ticket: ["title", "description", "priority"],
    get_ticket: ["ticket_id"],
    close_ticket: ["ticket_id"],
    resolve_ticket: ["ticket_id", "resolution"],
    edit_ticket: ["ticket_id", "updates"],
    ticket_login: ["username", "password"],
    ticket_get_login_status: [],
    logout: [],
    get_user_tickets: ["status"],
  };

  static parseFunctionCall(funcCall: string): {
    methodName: string;
    args: any[];
  } {
    const match = funcCall.match(/^(\w+(?:\.\w+)?)\((.*)\)$/s);
    if (!match) {
      throw new Error(`Invalid function call format: ${funcCall}`);
    }

    const [, fullMethodName, argsString] = match;
    const methodName = fullMethodName.split(".").pop() || fullMethodName;

    const args: any[] = [];
    if (!argsString.trim()) {
      return { methodName, args };
    }

    const parsedArgs = SafeExecutor.parseArgsString(argsString);
    const paramOrder = SafeExecutor.METHOD_PARAMS[methodName];

    if (paramOrder && parsedArgs.some((a) => a.key)) {
      const argMap = new Map<string, any>();
      const positional: any[] = [];

      for (const arg of parsedArgs) {
        if (arg.key) {
          argMap.set(arg.key, arg.value);
        } else {
          positional.push(arg.value);
        }
      }

      let posIdx = 0;
      for (const paramName of paramOrder) {
        if (argMap.has(paramName)) {
          args.push(argMap.get(paramName));
        } else if (posIdx < positional.length) {
          args.push(positional[posIdx++]);
        }
      }
    } else {
      for (const arg of parsedArgs) {
        args.push(arg.value);
      }
    }

    return { methodName, args };
  }

  static parseArgsString(
    argsString: string
  ): Array<{ key?: string; value: any }> {
    const results: Array<{ key?: string; value: any }> = [];
    let i = 0;
    const s = argsString.trim();

    while (i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) break;

      let key: string | undefined;
      const keyMatch = s.slice(i).match(/^(\w+)\s*=/);
      if (keyMatch) {
        key = keyMatch[1];
        i += keyMatch[0].length;
      }

      while (i < s.length && /\s/.test(s[i])) i++;

      const value = SafeExecutor.parseValue(s, i);
      i = value.endIndex;
      results.push({ key, value: value.value });

      while (i < s.length && /\s/.test(s[i])) i++;
      if (i < s.length && s[i] === ",") i++;
    }

    return results;
  }

  static parseValue(
    s: string,
    start: number
  ): { value: any; endIndex: number } {
    let i = start;
    while (i < s.length && /\s/.test(s[i])) i++;

    if (s[i] === "'" || s[i] === '"') {
      const quote = s[i];
      i++;
      let value = "";
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const next = s[i + 1];
          if (next === "n") {
            value += "\n";
          } else if (next === "t") {
            value += "\t";
          } else if (next === "r") {
            value += "\r";
          } else {
            value += next;
          }
          i += 2;
        } else {
          value += s[i];
          i++;
        }
      }
      return { value, endIndex: i + 1 };
    }

    if (s[i] === "[") {
      return SafeExecutor.parseList(s, i);
    }

    if (s[i] === "{") {
      return SafeExecutor.parseDict(s, i);
    }

    let token = "";
    while (i < s.length && !/[,)\]}]/.test(s[i])) {
      token += s[i];
      i++;
    }
    token = token.trim();

    if (token === "True") return { value: true, endIndex: i };
    if (token === "False") return { value: false, endIndex: i };
    if (token === "None") return { value: null, endIndex: i };
    const num = Number(token);
    if (!Number.isNaN(num)) return { value: num, endIndex: i };
    return { value: token, endIndex: i };
  }

  static parseList(
    s: string,
    start: number
  ): { value: any[]; endIndex: number } {
    const items: any[] = [];
    let i = start + 1;
    while (i < s.length && s[i] !== "]") {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === "]") break;
      const item = SafeExecutor.parseValue(s, i);
      items.push(item.value);
      i = item.endIndex;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === ",") i++;
    }
    return { value: items, endIndex: i + 1 };
  }

  static parseDict(
    s: string,
    start: number
  ): { value: Record<string, any>; endIndex: number } {
    const obj: Record<string, any> = {};
    let i = start + 1;
    while (i < s.length && s[i] !== "}") {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === "}") break;
      const keyResult = SafeExecutor.parseValue(s, i);
      i = keyResult.endIndex;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === ":") i++;
      const valResult = SafeExecutor.parseValue(s, i);
      obj[String(keyResult.value)] = valResult.value;
      i = valResult.endIndex;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] === ",") i++;
    }
    return { value: obj, endIndex: i + 1 };
  }

  static findInstanceForMethod(
    methodName: string,
    involvedInstances?: Record<string, any>
  ): any {
    if (involvedInstances) {
      for (const instance of Object.values(involvedInstances)) {
        if (instance && typeof instance[methodName] === "function") {
          return instance;
        }
      }
    }
    return globalMethodRegistry.getInstanceByMethod(methodName);
  }

  static async executeFunctionCall(
    funcCall: string,
    involvedInstances?: Record<string, any>
  ): Promise<ExecutionResult> {
    try {
      const { methodName, args } = SafeExecutor.parseFunctionCall(funcCall);

      const instance = SafeExecutor.findInstanceForMethod(
        methodName,
        involvedInstances
      );

      if (!instance) {
        return {
          success: false,
          error: `Instance not found for method: ${methodName}`,
        };
      }

      if (typeof instance[methodName] !== "function") {
        return {
          success: false,
          error: `Method not found: ${methodName}`,
        };
      }

      const result = instance[methodName](...args);

      const finalResult = result instanceof Promise ? await result : result;

      return {
        success: true,
        result: finalResult,
      };
    } catch (error) {
      return {
        success: false,
        error: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Execute multiple function calls and return serialized results
  static async executeFunctionCalls(funcCalls: string[]): Promise<string[]> {
    const results: string[] = [];

    for (const funcCall of funcCalls) {
      const executionResult = await SafeExecutor.executeFunctionCall(funcCall);

      if (executionResult.success) {
        // Serialize result similar to Python implementation
        const result = executionResult.result;
        let serialized: string;

        if (typeof result === "string") {
          serialized = result;
        } else if (result === null || result === undefined) {
          serialized = "None";
        } else if (typeof result === "object") {
          try {
            serialized = JSON.stringify(result);
          } catch {
            serialized = String(result);
          }
        } else {
          serialized = String(result);
        }

        results.push(serialized);
      } else {
        results.push(`Error during execution: ${executionResult.error}`);
      }
    }

    return results;
  }

  // Validate that dangerous operations are blocked
  static validateFunctionCall(funcCall: string): boolean {
    // Block dangerous operations (similar to Python implementation)
    const dangerousPatterns = [
      /\bkill\b/,
      /\bexit\b/,
      /\bquit\b/,
      /\bsystem\b/,
      /\bexec\b/,
      /\beval\b/,
      /\bimport\b/,
      /__\w+__/, // Dunder methods
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(funcCall)) {
        return false;
      }
    }

    return true;
  }

  static async executeFunctionCallSafe(
    funcCall: string,
    involvedInstances?: Record<string, any>
  ): Promise<ExecutionResult> {
    if (!SafeExecutor.validateFunctionCall(funcCall)) {
      return {
        success: false,
        error: `Dangerous function call blocked: ${funcCall}`,
      };
    }

    return SafeExecutor.executeFunctionCall(funcCall, involvedInstances);
  }
}
