import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CODEX_HOME points at a per-test temp directory so the real ~/.codex cache
// on the developer's machine never influences the result.
let codexHome = "";
let originalCodexHome: string | undefined;

/** Minimal cache entry; fields mirror the real models_cache.json shape. */
function model(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: "gpt-test",
    priority: 1,
    visibility: "list",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    ...overrides
  };
}

async function writeCatalog(contents: unknown): Promise<void> {
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify(contents), "utf8");
}

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "llm-clash-codex-"));
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  vi.resetModules();
});

afterEach(async () => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  await rm(codexHome, { recursive: true, force: true });
});

describe("topSpecForAgent", () => {
  it("falls back to the curated spec when no catalog file exists", async () => {
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.5-high");
  });

  it("picks the lowest priority number and appends high effort", async () => {
    await writeCatalog({
      models: [
        model({ slug: "gpt-5.5", priority: 7 }),
        model({ slug: "gpt-5.6-sol", priority: 1 }),
        model({ slug: "gpt-5.6-terra", priority: 2 })
      ]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.6-sol-high");
  });

  it("ignores models the catalog marks as hidden", async () => {
    await writeCatalog({
      models: [
        model({ slug: "codex-auto-review", priority: 1, visibility: "hide" }),
        model({ slug: "gpt-5.6-sol", priority: 4 })
      ]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.6-sol-high");
  });

  it("keeps models the hosted API does not serve, since the CLI still runs them", async () => {
    await writeCatalog({
      models: [model({ slug: "gpt-5.3-codex-spark", priority: 1, supported_in_api: false })]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.3-codex-spark-high");
  });

  it("omits the effort suffix when the top model does not support high", async () => {
    await writeCatalog({
      models: [
        model({
          slug: "gpt-fast",
          priority: 1,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }]
        })
      ]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-fast");
  });

  it("assumes high effort when the catalog lists no reasoning levels", async () => {
    await writeCatalog({
      models: [model({ slug: "gpt-plain", priority: 1, supported_reasoning_levels: [] })]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-plain-high");
  });

  it("rejects slugs that could inject extra codex arguments", async () => {
    await writeCatalog({
      models: [
        model({ slug: "--sandbox danger-full-access", priority: 1 }),
        model({ slug: "gpt-5.6-sol", priority: 9 })
      ]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.6-sol-high");
  });

  it("skips entries with a missing or non-numeric priority", async () => {
    await writeCatalog({
      models: [
        model({ slug: "gpt-broken", priority: "first" }),
        model({ slug: "gpt-missing", priority: undefined }),
        model({ slug: "gpt-5.6-sol", priority: 3 })
      ]
    });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.6-sol-high");
  });

  it("falls back to the curated spec when the catalog is corrupt", async () => {
    await writeFile(join(codexHome, "models_cache.json"), "{ not json", "utf8");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.5-high");
  });

  it("falls back to the curated spec when every entry is unusable", async () => {
    await writeCatalog({ models: [model({ slug: "", priority: 1 })] });
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("codex")).toBe("codex:gpt-5.5-high");
  });

  it("uses rolling aliases for agents that have no catalog reader", async () => {
    const { topSpecForAgent } = await import("../src/cli/agentCatalog.js");
    expect(topSpecForAgent("claude-code")).toBe("claude-code:opus-high");
    expect(topSpecForAgent("gemini-cli")).toBe("gemini-cli:flash");
  });
});

describe("hasCuratedDefault", () => {
  it("is true for agents with a default and false for opencode", async () => {
    const { hasCuratedDefault } = await import("../src/cli/agentCatalog.js");
    expect(hasCuratedDefault("codex")).toBe(true);
    expect(hasCuratedDefault("claude-code")).toBe(true);
    expect(hasCuratedDefault("gemini-cli")).toBe(true);
    expect(hasCuratedDefault("opencode")).toBe(false);
  });
});
