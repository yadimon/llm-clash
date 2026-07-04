import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { mockAdapter } from "../src/adapters/mock.js";
import { runMultiDraftRefinement } from "../src/core/orchestrator.js";
import type { RunEvent } from "../src/core/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runMultiDraftRefinement", () => {
  it("runs initial drafts, refinement, evaluation, and writes artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "multidraft-test-"));
    tempDirs.push(outputDir);

    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => responseFor("A", input.prompt)
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => responseFor("B", input.prompt)
    });

    const result = await runMultiDraftRefinement({
      task: "Create a migration plan.",
      models: [modelA, modelB],
      rounds: 1,
      finalMode: "choose_best",
      outputDir
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.finalDrafts).toHaveLength(2);
    expect(result.winner?.modelId).toBe("model-a");
    expect(result.finalAnswer).toContain("Improved A");

    const final = await readFile(join(outputDir, "final.md"), "utf8");
    const aggregate = await readFile(join(outputDir, "evaluation", "aggregated.json"), "utf8");
    expect(final).toContain("Improved A");
    expect(JSON.parse(aggregate).winner).toBe(result.winner?.id);
  });

  it("can run without saving artifacts and emits progress events", async () => {
    const events: RunEvent["type"][] = [];
    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => responseFor("A", input.prompt)
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => responseFor("B", input.prompt)
    });

    const result = await runMultiDraftRefinement({
      task: "Create a migration plan.",
      models: [modelA, modelB],
      rounds: 1,
      finalMode: "choose_best",
      saveArtifacts: false,
      onEvent: (event) => events.push(event.type)
    });

    expect(result.outputDir).toBeUndefined();
    expect(result.startedAt).toBeTruthy();
    expect(result.finishedAt).toBeTruthy();
    expect(events).toContain("round_start");
    expect(events).toContain("draft_start");
    expect(events).toContain("draft_created");
    expect(events).toContain("evaluation_complete");
    expect(events).toContain("run_complete");
  });

  it("emits the failing model before surfacing generation errors", async () => {
    const events: RunEvent[] = [];
    const modelA = mockAdapter({
      id: "model-a",
      generate: () => {
        throw new Error("model-a unavailable");
      }
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => responseFor("B", input.prompt)
    });

    await expect(
      runMultiDraftRefinement({
        task: "Create a migration plan.",
        models: [modelA, modelB],
        rounds: 0,
        finalMode: "choose_best",
        saveArtifacts: false,
        onEvent: (event) => events.push(event)
      })
    ).rejects.toThrow(/model-a unavailable/);

    expect(events).toContainEqual({
      type: "draft_start",
      modelId: "model-a",
      round: 0,
      phase: "initial"
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "draft_failed",
          modelId: "model-a",
          round: 0,
          phase: "initial"
        })
      ])
    );
  });

  it("rejects malformed evaluation criteria before any model call", async () => {
    let calls = 0;
    const model = mockAdapter({
      id: "model-a",
      generate: () => {
        calls += 1;
        return "should never be produced";
      }
    });

    await expect(
      runMultiDraftRefinement({
        task: "Create a migration plan.",
        models: [model],
        evaluationCriteria: ["guardrail quality!"],
        saveArtifacts: false
      })
    ).rejects.toThrow('Invalid evaluation criterion: "guardrail quality!"');
    expect(calls).toBe(0);
  });

  it("rejects an empty evaluation criteria list before any model call", async () => {
    let calls = 0;
    const model = mockAdapter({
      id: "model-a",
      generate: () => {
        calls += 1;
        return "should never be produced";
      }
    });

    await expect(
      runMultiDraftRefinement({
        task: "Create a migration plan.",
        models: [model],
        evaluationCriteria: [],
        saveArtifacts: false
      })
    ).rejects.toThrow("RunConfig.evaluationCriteria must include at least one criterion.");
    expect(calls).toBe(0);
  });

  it("supports custom criteria end-to-end from judge prompt to aggregated scores", async () => {
    const judgePrompts: string[] = [];
    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => {
        if (input.prompt.includes("Evaluate several candidate answers")) {
          judgePrompts.push(input.prompt);
        }
        return customCriteriaResponseFor("A", input.prompt);
      }
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => customCriteriaResponseFor("B", input.prompt)
    });

    const result = await runMultiDraftRefinement({
      task: "Create a migration plan.",
      models: [modelA, modelB],
      rounds: 0,
      finalMode: "choose_best",
      evaluationCriteria: ["goal_fit", "guardrail_quality"],
      saveArtifacts: false
    });

    expect(judgePrompts[0]).toContain("Guardrail Quality: X/10");
    expect(judgePrompts[0]).toContain("Judge this criterion by its name.");
    expect(result.winner?.modelId).toBe("model-a");
    const winnerScores = result.aggregatedEvaluation.candidates[0]?.scores;
    expect(winnerScores?.guardrail_quality).toBeCloseTo(8.333, 2);
    expect(winnerScores?.goal_fit).toBeCloseTo(8.333, 2);
  });

  it("persists finished drafts incrementally so a judge crash cannot lose them", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "multidraft-test-"));
    tempDirs.push(outputDir);

    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => crashingJudgeResponseFor("A", input.prompt)
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => crashingJudgeResponseFor("B", input.prompt)
    });

    await expect(
      runMultiDraftRefinement({
        task: "Create a migration plan.",
        models: [modelA, modelB],
        rounds: 1,
        outputDir
      })
    ).rejects.toThrow("judge crashed");

    const initialDraft = await readFile(join(outputDir, "rounds", "round-0", "model-a.md"), "utf8");
    const refinedDraft = await readFile(join(outputDir, "rounds", "round-1", "model-b.md"), "utf8");
    const config = await readFile(join(outputDir, "config.yaml"), "utf8");
    const task = await readFile(join(outputDir, "task.md"), "utf8");
    expect(initialDraft).toContain("Initial A");
    expect(refinedDraft).toContain("Improved B");
    expect(config).toContain("model-a");
    expect(task).toBe("Create a migration plan.");
  });

  it("persists finished judgments incrementally so a synthesis crash cannot lose them", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "multidraft-test-"));
    tempDirs.push(outputDir);

    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => crashingSynthesisResponseFor("A", input.prompt)
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: (input) => crashingSynthesisResponseFor("B", input.prompt)
    });

    await expect(
      runMultiDraftRefinement({
        task: "Create a migration plan.",
        models: [modelA, modelB],
        rounds: 0,
        finalMode: "synthesize",
        outputDir
      })
    ).rejects.toThrow("synthesis crashed");

    const judgeA = await readFile(join(outputDir, "evaluation", "model-a.md"), "utf8");
    const judgeB = await readFile(join(outputDir, "evaluation", "model-b.md"), "utf8");
    const initialDraft = await readFile(join(outputDir, "rounds", "round-0", "model-b.md"), "utf8");
    expect(judgeA).toContain("# Evaluation");
    expect(judgeB).toContain("# Evaluation");
    expect(initialDraft).toContain("Initial B");
  });

  it("emits completed drafts as each model finishes", async () => {
    const events: RunEvent[] = [];
    let releaseSlowDraft: (() => void) | undefined;
    let slowInitialReleased = false;
    const modelA = mockAdapter({
      id: "model-a",
      generate: (input) => responseFor("A", input.prompt)
    });
    const modelB = mockAdapter({
      id: "model-b",
      generate: async (input) => {
        if (!input.prompt.includes("Evaluate several candidate answers") && !slowInitialReleased) {
          await new Promise<void>((resolve) => {
            releaseSlowDraft = () => {
              slowInitialReleased = true;
              resolve();
            };
          });
        }
        return responseFor("B", input.prompt);
      }
    });

    const run = runMultiDraftRefinement({
      task: "Create a migration plan.",
      models: [modelA, modelB],
      rounds: 0,
      finalMode: "choose_best",
      saveArtifacts: false,
      onEvent: (event) => events.push(event)
    });

    await waitForEvent(
      events,
      (event) => event.type === "draft_created" && event.draft.modelId === "model-a"
    );
    expect(events.some((event) => event.type === "round_complete" && event.round === 0)).toBe(
      false
    );

    releaseSlowDraft?.();
    await run;

    expect(
      events.some((event) => event.type === "draft_created" && event.draft.modelId === "model-b")
    ).toBe(true);
  });
});

function responseFor(label: string, prompt: string): string {
  if (prompt.includes("Evaluate several candidate answers")) {
    const candidateOne = label === "A" ? 9 : 8.5;
    const candidateTwo = label === "A" ? 7 : 8;
    return `# Evaluation

## Candidate 1
Accuracy: ${candidateOne}/10
Completeness: ${candidateOne}/10
Usefulness: ${candidateOne}/10
Clarity: ${candidateOne}/10
Goal Fit: ${candidateOne}/10
Total: ${candidateOne}/10

## Candidate 2
Accuracy: ${candidateTwo}/10
Completeness: ${candidateTwo}/10
Usefulness: ${candidateTwo}/10
Clarity: ${candidateTwo}/10
Goal Fit: ${candidateTwo}/10
Total: ${candidateTwo}/10

# Best Candidate

Candidate 1

# Reason

Candidate 1 is stronger.`;
  }

  if (prompt.includes("Create an improved version")) {
    return `# Improved Answer

Improved ${label}

# Changes Made

Added detail.`;
  }

  return `Initial ${label}`;
}

/** Like `responseFor`, but scores the run's custom criteria set. */
function customCriteriaResponseFor(label: string, prompt: string): string {
  if (prompt.includes("Evaluate several candidate answers")) {
    const candidateOne = label === "A" ? 9 : 8;
    const candidateTwo = label === "A" ? 7 : 6;
    return `# Evaluation

## Candidate 1
Goal Fit: ${candidateOne}/10
Guardrail Quality: ${candidateOne}/10
Total: ${candidateOne}/10

## Candidate 2
Goal Fit: ${candidateTwo}/10
Guardrail Quality: ${candidateTwo}/10
Total: ${candidateTwo}/10

# Best Candidate

Candidate 1

# Reason

Stronger guardrails.`;
  }

  return responseFor(label, prompt);
}

/** Drafts normally, then fails when asked to act as a judge. */
function crashingJudgeResponseFor(label: string, prompt: string): string {
  if (prompt.includes("Evaluate several candidate answers")) {
    throw new Error("judge crashed");
  }
  return responseFor(label, prompt);
}

/** Drafts and judges normally, then fails during the synthesis pass. */
function crashingSynthesisResponseFor(label: string, prompt: string): string {
  if (prompt.includes("You need to create one final answer")) {
    throw new Error("synthesis crashed");
  }
  return responseFor(label, prompt);
}

async function waitForEvent(
  events: RunEvent[],
  predicate: (event: RunEvent) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (events.some(predicate)) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for event.");
}
