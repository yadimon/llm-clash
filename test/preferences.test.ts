import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We point `os.homedir()` at a per-test temp directory so the real
// ~/.config/llm-clash is never touched.
let fakeHome = "";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => fakeHome
  };
});

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "llm-clash-prefs-"));
  vi.resetModules();
});

afterEach(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

describe("preferences", () => {
  it("returns an empty object when the file does not exist", async () => {
    const { loadPreferences } = await import("../src/cli/preferences.js");
    expect(loadPreferences()).toEqual({});
  });

  it("round-trips defaultModels through save and load", async () => {
    const { loadPreferences, savePreferences } = await import("../src/cli/preferences.js");
    savePreferences({ defaultModels: ["codex:gpt-5.5-high", "claude-code:claude-opus-4-7-high"] });

    const loaded = loadPreferences();
    expect(loaded.defaultModels).toEqual([
      "codex:gpt-5.5-high",
      "claude-code:claude-opus-4-7-high"
    ]);
    expect(loaded.savedAt).toBeTypeOf("string");
  });

  it("creates the parent directory on save", async () => {
    const { savePreferences } = await import("../src/cli/preferences.js");
    savePreferences({ defaultModels: ["codex:gpt-5.5-high"] });

    expect(existsSync(join(fakeHome, ".config", "llm-clash", "preferences.json"))).toBe(true);
  });

  it("returns an empty object when the file is corrupt", async () => {
    const { savePreferences, loadPreferences } = await import("../src/cli/preferences.js");
    savePreferences({ defaultModels: ["x"] });
    const path = join(fakeHome, ".config", "llm-clash", "preferences.json");
    writeFileSync(path, "{not valid json", "utf8");

    expect(loadPreferences()).toEqual({});
  });
});
