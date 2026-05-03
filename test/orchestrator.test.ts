import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(events).toContain("draft_created");
    expect(events).toContain("evaluation_complete");
    expect(events).toContain("run_complete");
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
