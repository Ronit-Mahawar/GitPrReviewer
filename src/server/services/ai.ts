/**
 * The only file that talks to the model provider.
 * Gemini is reached through the OpenAI SDK pointed at Google's OpenAI-compatible endpoint.
 * The prompt, parsing and review logic live in src/server/review/ (pure, no SDK imports).
 */
import OpenAI from "openai";
import type { Llm } from "@/server/review/review-pull-request";

export const DEFAULT_REVIEW_MODEL = "gemini-3.1-flash-lite";

/** One SDK client per API key (production only ever uses one; evals may use a second for the judge). */
const clients = new Map<string, OpenAI>();

function getOpenAIClient(apiKeyOverride?: string): OpenAI {
  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  let client = clients.get(apiKey);
  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
    clients.set(apiKey, client);
  }
  return client;
}

export interface GeminiOptions {
  /** Defaults to REVIEW_MODEL, then DEFAULT_REVIEW_MODEL. */
  model?: string;
  /** Defaults to 0.3 (production). The eval runner passes 0. */
  temperature?: number;
  /**
   * Per-request timeout with no SDK retries, for callers that retry themselves (the eval judge).
   * Unset in production, which keeps the SDK defaults (10 min timeout, 2 retries).
   */
  timeoutMs?: number;
  /**
   * Use this key instead of GEMINI_API_KEY. The eval judge passes JUDGE_API_KEY so it can use
   * another Google project's free-tier quota. Empty or unset falls back to GEMINI_API_KEY.
   */
  apiKey?: string;
}

/** Returns an `llm` function for reviewPullRequest that calls Gemini in JSON mode. */
export function createGeminiLlm(options: GeminiOptions = {}): Llm {
  const model = options.model || process.env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL; // || so an empty env var falls back
  const temperature = options.temperature ?? 0.3;

  return async (messages) => {
    const params = {
      model,
      messages,
      response_format: { type: "json_object" as const },
      temperature,
      max_tokens: 3000,
    };
    const client = getOpenAIClient(options.apiKey);
    const response = options.timeoutMs
      ? await client.chat.completions.create(params, { timeout: options.timeoutMs, maxRetries: 0 })
      : await client.chat.completions.create(params);
    return {
      content: response.choices[0]?.message?.content ?? null,
      model,
      promptTokens: response.usage?.prompt_tokens ?? null,
      completionTokens: response.usage?.completion_tokens ?? null,
      finishReason: response.choices[0]?.finish_reason ?? null,
    };
  };
}
