import { describe, expect, it } from "vitest";
import { release } from "../scripts/release.mjs";

describe("release workflow", () => {
  const cleanMain = (args) =>
    args[0] === "branch" ? "main" : args[0] === "status" ? "" : "same-sha";

  it("checks before bumping and creates a conventional commit and explicit atomic tag push", () => {
    const calls = [];
    release("patch", {
      run: (command, args) => calls.push([command, ...args]),
      capture: cleanMain,
      readVersion: () => "1.2.4"
    });
    expect(calls.indexOf(calls.find((call) => call[1] === "run"))).toBeLessThan(
      calls.indexOf(calls.find((call) => call[1] === "version"))
    );
    expect(calls).toContainEqual(["npm", "version", "patch", "--no-git-tag-version"]);
    expect(calls).toContainEqual(["git", "commit", "-m", "chore(release): v1.2.4"]);
    expect(calls.at(-1)).toEqual([
      "git",
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      "refs/tags/v1.2.4"
    ]);
  });

  it.each(["branch", "dirty", "behind"])("stops before changing versions on %s state", (state) => {
    const calls = [];
    const capture = (args) => {
      if (state === "branch" && args[0] === "branch") return "feature";
      if (state === "dirty" && args[0] === "status") return " M src/index.ts";
      if (state === "behind" && args[1] === "origin/main") return "new-sha";
      return cleanMain(args);
    };
    expect(() =>
      release("patch", { run: (command, args) => calls.push([command, ...args]), capture })
    ).toThrow();
    expect(calls.some((call) => call[0] === "npm")).toBe(false);
  });
});
