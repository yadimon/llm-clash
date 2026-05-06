import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgentName } from "../src/cli/detection.js";

let installed: LocalAgentName[] = [];
let savedPrefs: { defaultModels?: string[] } = {};
let savedCalls: Array<{ defaultModels?: string[] }> = [];
let originalIsTTY: boolean | undefined;

vi.mock("../src/cli/detection.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/cli/detection.js")>("../src/cli/detection.js");
  return {
    ...actual,
    detectInstalledAgents: () => installed
  };
});

vi.mock("../src/cli/preferences.js", () => ({
  loadPreferences: () => savedPrefs,
  savePreferences: (prefs: { defaultModels?: string[] }) => {
    savedCalls.push(prefs);
  }
}));

beforeEach(() => {
  installed = [];
  savedPrefs = {};
  savedCalls = [];
  // Force the non-TTY branch so the prompt is skipped — keeps tests
  // deterministic and avoids reading from real stdin.
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalIsTTY,
    configurable: true
  });
});

describe("autoSelectModels", () => {
  it("picks the top two by priority when all four are installed", async () => {
    installed = ["codex", "claude-code", "gemini-cli", "opencode"];
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    const result = await autoSelectModels();

    expect(result.specs).toEqual(["codex:gpt-5.5-high", "claude-code:claude-opus-4-7-high"]);
    expect(result.fromPreferences).toBe(false);
  });

  it("skips opencode in favor of curated-default agents", async () => {
    installed = ["codex", "gemini-cli", "opencode"];
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    const result = await autoSelectModels();

    expect(result.specs).toEqual(["codex:gpt-5.5-high", "gemini-cli:flash"]);
  });

  it("uses a saved selection when every agent is still installed", async () => {
    installed = ["codex", "claude-code"];
    savedPrefs = {
      defaultModels: ["codex:gpt-5.5-high", "claude-code:claude-opus-4-7-high"]
    };
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    const result = await autoSelectModels();

    expect(result.fromPreferences).toBe(true);
    expect(result.specs).toEqual(savedPrefs.defaultModels);
  });

  it("ignores a saved selection if the agents are no longer installed", async () => {
    installed = ["claude-code", "gemini-cli"];
    savedPrefs = {
      defaultModels: ["codex:gpt-5.5-high", "claude-code:claude-opus-4-7-high"]
    };
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    const result = await autoSelectModels();

    expect(result.fromPreferences).toBe(false);
    expect(result.specs).toEqual(["claude-code:claude-opus-4-7-high", "gemini-cli:flash"]);
  });

  it("throws when fewer than two CLIs are installed", async () => {
    installed = ["codex"];
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    await expect(autoSelectModels()).rejects.toThrow(/at least two local LLM CLIs/);
  });

  it("throws when only opencode plus zero curated-default CLIs are installed", async () => {
    installed = ["opencode"];
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    await expect(autoSelectModels()).rejects.toThrow(/at least two local LLM CLIs/);
  });

  it("throws when picking would force using opencode as a default", async () => {
    installed = ["gemini-cli", "opencode"];
    const { autoSelectModels } = await import("../src/cli/autoSelect.js");

    await expect(autoSelectModels()).rejects.toThrow(/opencode has too many models/);
  });
});
