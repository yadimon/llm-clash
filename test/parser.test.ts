import { describe, expect, it } from "vitest";
import {
  extractImprovedAnswer,
  parseBestCandidate,
  parseCandidateBlock,
  parseEvaluationText,
  splitCandidateBlocks
} from "../src/core/parser.js";
import type { Draft } from "../src/core/types.js";

const drafts: Draft[] = [
  {
    id: "candidate-a",
    modelId: "model-a",
    round: 1,
    text: "A",
    createdAt: "2026-05-03T00:00:00.000Z"
  },
  {
    id: "candidate-b",
    modelId: "model-b",
    round: 1,
    text: "B",
    createdAt: "2026-05-03T00:00:00.000Z"
  }
];

describe("parser", () => {
  it("splits candidate blocks and extracts strengths and weaknesses", () => {
    const blocks = splitCandidateBlocks(`# Evaluation

## Candidate 1
Accuracy: 11/10
Goal Fit: 8/10
Total: 9.5/10

Strengths:
- Clear

Weaknesses:
- Thin risks

## Candidate 2
Accuracy: 7/10`);

    expect(blocks).toHaveLength(2);
    const parsed = parseCandidateBlock(blocks[0]?.body ?? "", ["accuracy", "goal_fit"]);
    expect(parsed.scores.accuracy).toBe(10);
    expect(parsed.strengths).toEqual(["Clear"]);
    expect(parsed.weaknesses).toEqual(["Thin risks"]);
  });

  it("maps markdown evaluation to draft ids", () => {
    const evaluation = parseEvaluationText(
      `# Evaluation

## Candidate 1
Accuracy: 8/10
Completeness: 8/10
Usefulness: 8/10
Clarity: 8/10
Goal Fit: 8/10

## Candidate 2
Accuracy: 9/10
Completeness: 9/10
Usefulness: 9/10
Clarity: 9/10
Goal Fit: 9/10

# Best Candidate

Candidate 2

# Reason

Better fit.`,
      drafts,
      ["accuracy", "completeness", "usefulness", "clarity", "goal_fit"],
      "judge"
    );

    expect(evaluation.bestCandidateId).toBe("candidate-b");
    expect(evaluation.reason).toBe("Better fit.");
    expect(evaluation.candidateScores[1]?.total).toBe(9);
  });

  it("extracts improved answer and changes", () => {
    expect(
      extractImprovedAnswer(`# Improved Answer

Better answer.

# Changes Made

Added specifics.`)
    ).toEqual({ answer: "Better answer.", notes: "Added specifics." });
    expect(parseBestCandidate("# Best Candidate\n\nCandidate 3").index).toBe(3);
  });
});
