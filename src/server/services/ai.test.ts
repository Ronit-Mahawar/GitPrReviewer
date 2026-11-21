import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn(), constructed: [] as Array<{ apiKey: string }> }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mock.create } };
    constructor(opts: { apiKey: string }) {
      mock.constructed.push(opts);
    }
  },
}));

import { createGeminiLlm, DEFAULT_REVIEW_MODEL } from "./ai";

const messages = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "user" },
];

function response(content: string | null) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
}

describe("createGeminiLlm", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-only-key";
    delete process.env.REVIEW_MODEL;
    mock.create.mockReset();
  });
  afterEach(() => {
    delete process.env.REVIEW_MODEL;
  });

  it("sends the same request parameters as v1 and maps the reply", async () => {
    mock.create.mockResolvedValue(response('{"ok":true}'));
    const reply = await createGeminiLlm()(messages);

    expect(mock.create).toHaveBeenCalledWith({
      model: DEFAULT_REVIEW_MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 3000,
    });
    expect(reply).toEqual({ content: '{"ok":true}', model: DEFAULT_REVIEW_MODEL, promptTokens: 20, completionTokens: 8, finishReason: "stop" });
  });

  it("uses REVIEW_MODEL, and falls back to the default when it is empty", async () => {
    mock.create.mockResolvedValue(response("{}"));
    process.env.REVIEW_MODEL = "gemini-other";
    await createGeminiLlm()(messages);
    expect(mock.create.mock.calls[0][0].model).toBe("gemini-other");

    process.env.REVIEW_MODEL = "";
    await createGeminiLlm()(messages);
    expect(mock.create.mock.calls[1][0].model).toBe(DEFAULT_REVIEW_MODEL);
  });

  it("lets options override model and temperature", async () => {
    mock.create.mockResolvedValue(response("{}"));
    await createGeminiLlm({ model: "m", temperature: 0 })(messages);
    expect(mock.create).toHaveBeenCalledWith(expect.objectContaining({ model: "m", temperature: 0 }));
  });

  it("passes a timeout with no SDK retries only when timeoutMs is set", async () => {
    mock.create.mockResolvedValue(response("{}"));
    await createGeminiLlm()(messages);
    expect(mock.create.mock.calls[0]).toHaveLength(1);
    await createGeminiLlm({ timeoutMs: 60_000 })(messages);
    expect(mock.create.mock.calls[1][1]).toEqual({ timeout: 60_000, maxRetries: 0 });
  });

  it("uses options.apiKey instead of GEMINI_API_KEY when given, and falls back when it is empty", async () => {
    mock.create.mockResolvedValue(response("{}"));
    mock.constructed.length = 0;
    await createGeminiLlm({ apiKey: "judge-only-key" })(messages);
    await createGeminiLlm({ apiKey: "" })(messages);
    await createGeminiLlm({ apiKey: "judge-only-key" })(messages); // reuses the client for that key
    expect(mock.constructed.map((o) => o.apiKey)).toEqual(expect.arrayContaining(["judge-only-key"]));
    expect(mock.constructed.filter((o) => o.apiKey === "judge-only-key")).toHaveLength(1);
    expect(mock.constructed.every((o) => o.apiKey === "judge-only-key" || o.apiKey === "test-only-key")).toBe(true);
  });

  it("returns null content and null usage when the provider omits them", async () => {
    mock.create.mockResolvedValue({ choices: [] });
    expect(await createGeminiLlm()(messages)).toEqual({
      content: null, model: DEFAULT_REVIEW_MODEL, promptTokens: null, completionTokens: null, finishReason: null,
    });
  });

  it("propagates provider errors", async () => {
    mock.create.mockRejectedValue(new Error("request timeout"));
    await expect(createGeminiLlm()(messages)).rejects.toThrow("request timeout");
  });

  it("throws when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    vi.resetModules();
    const fresh = await import("./ai");
    await expect(fresh.createGeminiLlm()(messages)).rejects.toThrow("GEMINI_API_KEY is not set");
  });
});
