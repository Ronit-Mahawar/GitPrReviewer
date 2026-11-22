/**
 * Turns the model's text reply into a validated ReviewResult, or throws.
 */
import type { z } from "zod";

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Thrown when the reply isn't JSON or doesn't match ReviewResultSchema. Carries the usage so it can still be saved. */
export class ReviewOutputValidationError extends Error {
  constructor(public readonly rawOutput: string, public readonly usage: TokenUsage, cause: unknown) {
    super("AI review output failed Zod validation", { cause });
    this.name = "ReviewOutputValidationError";
  }
}

/**
 * Parses the model's JSON reply. Models sometimes wrap the object in a code fence or
 * append stray characters (e.g. a trailing "``"), so on failure fall back to the first
 * balanced top-level {...} in the text.
 */
export function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (firstError) {
    const start = content.indexOf("{");
    if (start === -1) throw firstError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return JSON.parse(content.slice(start, i + 1));
    }
    throw firstError;
  }
}

/** JSON-parses the reply and validates it against `schema`. Throws ReviewOutputValidationError on either failure. */
export function parseReply<T>(schema: z.ZodType<T>, content: string, usage: TokenUsage): T {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(content);
  } catch (error) {
    throw new ReviewOutputValidationError(content, usage, error);
  }
  const validation = schema.safeParse(parsed);
  if (!validation.success) throw new ReviewOutputValidationError(content, usage, validation.error);
  return validation.data;
}
