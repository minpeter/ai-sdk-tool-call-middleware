import { globalMethodRegistry } from "./method-registry";

export interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export class SafeExecutor {
  private static readonly DANGEROUS_METHODS = new Set([
    "kill",
    "exit",
    "quit",
    "system",
    "exec",
    "eval",
    "import",
  ]);

  private static readonly METHOD_PARAM_ORDER: Record<string, string[]> = {
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
    mean: ["numbers"],
    std: ["numbers"],
    add: ["a", "b"],
    subtract: ["a", "b"],
    multiply: ["a", "b"],
    divide: ["a", "b"],
    absolute: ["number"],
    power: ["base", "exponent"],
    logarithm: ["value", "base"],
    log: ["value", "base"],
    send_message: ["receiver_id", "message"],
    view_messages_received: [],
    view_messages_sent: [],
    add_contact: ["user_name", "user_id"],
    delete_contact: ["user_id"],
    search_messages: ["keyword"],
    get_message_stats: [],
  };

  private static extractMethodName(toolName: string): string {
    return toolName.split(".").pop() ?? toolName;
  }

  private static snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  private static getMethodVariants(methodName: string): string[] {
    const camelCase = SafeExecutor.snakeToCamel(methodName);
    if (camelCase === methodName) {
      return [methodName];
    }
    return [methodName, camelCase];
  }

  private static findInstanceAndMethod(
    methodName: string,
    involvedInstances?: Record<string, unknown>
  ): { instance: unknown; resolvedMethodName: string } | undefined {
    const variants = SafeExecutor.getMethodVariants(methodName);

    if (involvedInstances) {
      for (const instance of Object.values(involvedInstances)) {
        if (instance && typeof instance === "object") {
          for (const variant of variants) {
            if (
              variant in instance &&
              typeof (instance as Record<string, unknown>)[variant] ===
                "function"
            ) {
              return { instance, resolvedMethodName: variant };
            }
          }
        }
      }
    }

    for (const variant of variants) {
      try {
        const instance = globalMethodRegistry.getInstanceByMethod(variant);
        if (instance) {
          return { instance, resolvedMethodName: variant };
        }
      } catch {}
    }
    return undefined;
  }

  private static buildArgs(
    methodName: string,
    args: Record<string, unknown>
  ): unknown[] {
    const paramOrder = SafeExecutor.METHOD_PARAM_ORDER[methodName];
    if (!paramOrder) {
      return Object.values(args);
    }
    return paramOrder.map((param) => args[param]);
  }

  private static isDangerous(methodName: string): boolean {
    return (
      SafeExecutor.DANGEROUS_METHODS.has(methodName) ||
      methodName.startsWith("__")
    );
  }

  static async execute(
    toolCall: ToolCall,
    involvedInstances?: Record<string, unknown>
  ): Promise<ExecutionResult> {
    const methodName = SafeExecutor.extractMethodName(toolCall.toolName);

    if (SafeExecutor.isDangerous(methodName)) {
      return {
        success: false,
        error: `Dangerous method blocked: ${methodName}`,
      };
    }

    const found = SafeExecutor.findInstanceAndMethod(
      methodName,
      involvedInstances
    );
    if (!found) {
      return {
        success: false,
        error: `Instance not found for method: ${methodName}`,
      };
    }

    const { instance, resolvedMethodName } = found;
    const method = (instance as Record<string, unknown>)[resolvedMethodName];
    if (typeof method !== "function") {
      return {
        success: false,
        error: `Method not found: ${methodName}`,
      };
    }

    try {
      const args = SafeExecutor.buildArgs(methodName, toolCall.args);
      const result = method.apply(instance, args);
      const finalResult = result instanceof Promise ? await result : result;

      return { success: true, result: finalResult };
    } catch (error) {
      return {
        success: false,
        error: `Execution error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  static async executeMany(
    toolCalls: ToolCall[],
    involvedInstances?: Record<string, unknown>
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const toolCall of toolCalls) {
      results.push(await SafeExecutor.execute(toolCall, involvedInstances));
    }
    return results;
  }

  static serializeResult(result: unknown): string {
    if (result === null || result === undefined) {
      return "None";
    }
    if (typeof result === "string") {
      return result;
    }
    if (typeof result === "object") {
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    }
    return String(result);
  }

  static parsePythonCall(pythonCall: string): ToolCall {
    const match = pythonCall.match(/^(\w+(?:\.\w+)?)\((.*)\)$/s);
    if (!match) {
      throw new Error(`Invalid function call format: ${pythonCall}`);
    }

    const [, fullMethodName, argsString] = match;
    const methodName = fullMethodName.split(".").pop() || fullMethodName;
    const args: Record<string, unknown> = {};

    if (!argsString.trim()) {
      return { toolName: methodName, args };
    }

    const parsedArgs = SafeExecutor.parseArgsString(argsString);
    const paramOrder = SafeExecutor.METHOD_PARAM_ORDER[methodName];

    if (paramOrder && parsedArgs.some((a) => a.key)) {
      for (const arg of parsedArgs) {
        if (arg.key) {
          args[arg.key] = arg.value;
        }
      }
    } else if (paramOrder) {
      let idx = 0;
      for (const arg of parsedArgs) {
        if (arg.key) {
          args[arg.key] = arg.value;
        } else if (idx < paramOrder.length) {
          args[paramOrder[idx]] = arg.value;
          idx++;
        }
      }
    } else {
      let idx = 0;
      for (const arg of parsedArgs) {
        if (arg.key) {
          args[arg.key] = arg.value;
        } else {
          args[`arg${idx}`] = arg.value;
          idx++;
        }
      }
    }

    return { toolName: methodName, args };
  }

  private static parseArgsString(
    argsString: string
  ): Array<{ key?: string; value: unknown }> {
    const results: Array<{ key?: string; value: unknown }> = [];
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

  private static parseValue(
    s: string,
    start: number
  ): { value: unknown; endIndex: number } {
    let i = start;
    while (i < s.length && /\s/.test(s[i])) i++;

    if (s[i] === "'" || s[i] === '"') {
      const quote = s[i];
      i++;
      let value = "";
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const next = s[i + 1];
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === "r") value += "\r";
          else value += next;
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

  private static parseList(
    s: string,
    start: number
  ): { value: unknown[]; endIndex: number } {
    const items: unknown[] = [];
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

  private static parseDict(
    s: string,
    start: number
  ): { value: Record<string, unknown>; endIndex: number } {
    const obj: Record<string, unknown> = {};
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
}
