import { describe, expect, it } from "vitest";
import { levelFor, limitFor, readInputTokens } from "./ContextMeter.js";

describe("limitFor", () => {
  it("returns the default when model is undefined", () => {
    expect(limitFor(undefined)).toBe(200_000);
  });

  it("returns 200k for standard model ids", () => {
    expect(limitFor("claude-opus-4-7")).toBe(200_000);
    expect(limitFor("claude-sonnet-4-6")).toBe(200_000);
    expect(limitFor("claude-haiku-4-5")).toBe(200_000);
  });

  it("returns 1M for the [1m] Opus variant", () => {
    expect(limitFor("claude-opus-4-7[1m]")).toBe(1_000_000);
  });

  it("strips trailing date suffix before lookup", () => {
    expect(limitFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("falls back to default for unknown models", () => {
    expect(limitFor("claude-future-9")).toBe(200_000);
  });
});

describe("readInputTokens", () => {
  it("returns null for missing or non-object usage", () => {
    expect(readInputTokens(null)).toBeNull();
    expect(readInputTokens(undefined)).toBeNull();
    expect(readInputTokens(42)).toBeNull();
  });

  it("returns null when no input-side counters present", () => {
    expect(readInputTokens({})).toBeNull();
    expect(readInputTokens({ output_tokens: 100 })).toBeNull();
  });

  it("sums input + cache_creation + cache_read", () => {
    expect(
      readInputTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 50,
      }),
    ).toBe(350);
  });

  it("tolerates missing cache fields", () => {
    expect(readInputTokens({ input_tokens: 42 })).toBe(42);
  });
});

describe("levelFor", () => {
  it("classifies under 60% as ok", () => {
    expect(levelFor(0)).toBe("ok");
    expect(levelFor(0.59)).toBe("ok");
  });

  it("classifies 60-85% as warn", () => {
    expect(levelFor(0.6)).toBe("warn");
    expect(levelFor(0.84)).toBe("warn");
  });

  it("classifies 85%+ as danger", () => {
    expect(levelFor(0.85)).toBe("danger");
    expect(levelFor(1)).toBe("danger");
  });
});
