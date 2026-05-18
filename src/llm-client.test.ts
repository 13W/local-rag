import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLlmSimple } from "./llm-client.js";
import type { RouterProviderSpec } from "./config.js";

const SPEC: RouterProviderSpec = {
  provider:     "gemini",
  model:        "test-model",
  api_key:      "dummy",
  url:          "https://stub.invalid",
  timeout:      5,
  max_attempts: 4,
};

function jsonResponse(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("_withRetry retryable status handling", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries on 500 and returns the eventual success body", async () => {
    fetchSpy
      .mockResolvedValueOnce(textResponse("internal", 500))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
      }));

    const out = await callLlmSimple("hi", SPEC);
    expect(out).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and honours Retry-After header (seconds)", async () => {
    fetchSpy
      .mockResolvedValueOnce(textResponse("busy", 503, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "back" }] } }],
      }));

    const out = await callLlmSimple("hi", SPEC);
    expect(out).toBe("back");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and uses 'retry in Xs' body hint as fallback", async () => {
    fetchSpy
      .mockResolvedValueOnce(textResponse('{"error":"please retry in 0.1s"}', 429))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "calm" }] } }],
      }));

    const out = await callLlmSimple("hi", SPEC);
    expect(out).toBe("calm");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting attempts on persistent 500", async () => {
    fetchSpy.mockResolvedValue(textResponse("dead", 500));

    await expect(callLlmSimple("hi", { ...SPEC, max_attempts: 2 })).rejects.toThrow(/Gemini simple: 500/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400 (non-retryable)", async () => {
    fetchSpy.mockResolvedValue(textResponse("bad request", 400));

    await expect(callLlmSimple("hi", SPEC)).rejects.toThrow(/Gemini simple: 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on TypeError: fetch failed (network error)", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({
        candidates: [{ content: { parts: [{ text: "recovered" }] } }],
      }));

    const out = await callLlmSimple("hi", SPEC);
    expect(out).toBe("recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting attempts on persistent network failure", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    await expect(callLlmSimple("hi", { ...SPEC, max_attempts: 2 })).rejects.toThrow(/NetworkError/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
