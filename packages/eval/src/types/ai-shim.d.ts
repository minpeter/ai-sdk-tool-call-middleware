declare module "ai" {
  /** Minimal shim for LanguageModel used by the eval package during typecheck */
  export interface LanguageModel {
    // Accept any call signature used in the codebase; keep minimal to avoid coupling
    call(input: unknown): Promise<unknown>;
  }

  export class OpenAI implements LanguageModel {
    constructor(opts?: Record<string, unknown>);
    call(input: unknown): Promise<unknown>;
  }
}
