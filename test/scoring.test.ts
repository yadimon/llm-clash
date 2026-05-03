import { describe, expect, it } from "vitest";
import { parseEvaluationText } from "../src/core/parser.js";
import { aggregateEvaluations } from "../src/core/scoring.js";
import type { Draft, EvaluationResult } from "../src/core/types.js";

const drafts: Draft[] = [
  {
    id: "candidate-1",
    modelId: "model-a",
    round: 2,
    text: "A",
    createdAt: "2026-05-02T00:00:00.000Z"
  },
  {
    id: "candidate-2",
    modelId: "model-b",
    round: 2,
    text: "B",
    createdAt: "2026-05-02T00:00:00.000Z"
  }
];

describe("parseEvaluationText", () => {
  it("extracts per-candidate criterion scores from markdown", () => {
    const evaluation = parseEvaluationText(
      `# Evaluation

## Candidate 1
Accuracy: 9/10
Completeness: 8.5/10
Usefulness: 9/10
Clarity: 8/10
Goal Fit: 9/10
Total: 8.7/10

## Candidate 2
Accuracy: 7/10
Completeness: 8/10
Usefulness: 7/10
Clarity: 8/10
Goal Fit: 7/10
Total: 7.4/10`,
      drafts,
      ["accuracy", "completeness", "usefulness", "clarity", "goal_fit"],
      "judge-a"
    );
    const scores = evaluation.candidateScores;

    expect(scores[0]?.total).toBe(8.7);
    expect(scores[0]?.scores.completeness).toBe(8.5);
    expect(scores[1]?.total).toBe(7.4);
    expect(evaluation.bestCandidateId).toBeUndefined();
  });
});

describe("aggregateEvaluations", () => {
  it("discounts self scores and selects the weighted winner", () => {
    const evaluations: EvaluationResult[] = [
      {
        judgeModelId: "model-a",
        text: "",
        candidateScores: [
          { candidateId: "candidate-1", total: 10, scores: { accuracy: 10 } },
          { candidateId: "candidate-2", total: 7, scores: { accuracy: 7 } }
        ]
      },
      {
        judgeModelId: "model-b",
        text: "",
        candidateScores: [
          { candidateId: "candidate-1", total: 8, scores: { accuracy: 8 } },
          { candidateId: "candidate-2", total: 9, scores: { accuracy: 9 } }
        ]
      }
    ];

    const aggregated = aggregateEvaluations(drafts, evaluations, ["accuracy"], 0.5, 1, 0.3);

    expect(aggregated.winner).toBe("candidate-1");
    expect(aggregated.candidates[0]?.weightedTotal).toBe(8.667);
    expect(aggregated.significantDifference).toBe(true);
  });
});
