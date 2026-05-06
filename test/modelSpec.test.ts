import { describe, expect, it } from "vitest";
import { adapterFromSpec } from "../src/cli/modelSpec.js";

describe("adapterFromSpec", () => {
  it("requires an OpenRouter API key for OpenRouter specs", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      expect(() => adapterFromSpec("openrouter:openrouter/free")).toThrow(
        /OPENROUTER_API_KEY is required/
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("creates OpenRouter adapters from explicit CLI keys", () => {
    const adapter = adapterFromSpec("openrouter:openrouter/free", {
      openrouterApiKey: "test-key"
    });

    expect(adapter.id).toBe("openrouter:openrouter/free");
  });

  it("creates local command adapters for supported CLI agent specs", () => {
    expect(adapterFromSpec("claude-code:sonnet-low").id).toBe("claude-code:sonnet-low");
    expect(adapterFromSpec("codex:gpt-5.4-mini-low").id).toBe("codex:gpt-5.4-mini-low");
    expect(adapterFromSpec("codex:default-low").id).toBe("codex:default-low");
    expect(adapterFromSpec("gemini-cli:flash").id).toBe("gemini-cli:flash");
    expect(adapterFromSpec("open-code:openrouter/openrouter/free").id).toBe(
      "open-code:openrouter/openrouter/free"
    );
  });

  it("expands bare-name shortcuts to full local-CLI specs", () => {
    expect(adapterFromSpec("cc").id).toBe("claude-code:claude-opus-4-7-high");
    expect(adapterFromSpec("claude-code").id).toBe("claude-code:claude-opus-4-7-high");
    expect(adapterFromSpec("codex").id).toBe("codex:gpt-5.5-high");
    expect(adapterFromSpec("gemini").id).toBe("gemini-cli:flash");
    expect(adapterFromSpec("gemini-cli").id).toBe("gemini-cli:flash");
  });

  it("rejects bare opencode because it has no curated default model", () => {
    expect(() => adapterFromSpec("opencode")).toThrow(/no default model/);
    expect(() => adapterFromSpec("open-code")).toThrow(/no default model/);
  });
});
