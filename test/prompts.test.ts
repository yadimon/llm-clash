import { describe, expect, it } from "vitest";
import { evaluationPrompt, initialPrompt, refinementPrompt } from "../src/core/prompts.js";
import type { Draft } from "../src/core/types.js";

const draft: Draft = {
  id: "a",
  modelId: "model-a",
  round: 0,
  text: "Draft A",
  createdAt: "2026-05-02T00:00:00.000Z"
};

describe("model-facing prompts", () => {
  it("use neutral draft language", () => {
    const prompts = [
      initialPrompt("Task"),
      refinementPrompt("Task", draft, [{ ...draft, id: "b", modelId: "model-b", text: "Draft B" }]),
      evaluationPrompt("Task", [draft], ["accuracy", "goal_fit"])
    ].join("\n");

    expect(prompts).not.toMatch(/\bagents?\b/i);
    expect(prompts).not.toMatch(/\bcompetitors?\b/i);
    expect(prompts).not.toMatch(/\bopponents?\b/i);
    expect(prompts).not.toMatch(/LLM battle/i);
    expect(prompts).toMatch(/Additional answer variants/);
    expect(prompts).toMatch(/candidate answers/);
  });
});
