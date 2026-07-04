import { describe, expect, it } from "vitest";
import {
  criterionLabel,
  evaluationPrompt,
  initialPrompt,
  refinementPrompt
} from "../src/core/prompts.js";
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

describe("criterionLabel", () => {
  it("uses curated labels for built-in criteria", () => {
    expect(criterionLabel("goal_fit")).toBe("Goal Fit");
    expect(criterionLabel("accuracy")).toBe("Accuracy");
  });

  it("generates a humanized label for custom criteria", () => {
    expect(criterionLabel("guardrail_quality")).toBe("Guardrail Quality");
    expect(criterionLabel("guardrail-quality")).toBe("Guardrail Quality");
    expect(criterionLabel("actionability")).toBe("Actionability");
  });
});

describe("evaluationPrompt with custom criteria", () => {
  it("uses the generated label in the criteria list and the score template", () => {
    const prompt = evaluationPrompt("Task", [draft], ["goal_fit", "guardrail_quality"]);

    expect(prompt).toContain("2. Guardrail Quality");
    expect(prompt).toContain("Judge this criterion by its name.");
    expect(prompt).toContain("Guardrail Quality: X/10");
    expect(prompt).toContain("Goal Fit: X/10");
    expect(prompt).not.toContain("undefined");
  });
});
