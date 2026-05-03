import type {
  AggregatedEvaluation,
  Draft,
  EvaluationCriterion,
  EvaluationResult
} from "./types.js";

export function aggregateEvaluations(
  finalDrafts: Draft[],
  evaluations: EvaluationResult[],
  criteria: EvaluationCriterion[],
  selfScoreWeight: number,
  peerScoreWeight: number,
  significantDifferenceThreshold = 0.3
): AggregatedEvaluation {
  const candidates = finalDrafts.map((draft) => {
    const weightedTotals: Array<{ score: number; weight: number }> = [];
    const weightedCriteria: Record<string, Array<{ score: number; weight: number }>> = {};

    for (const evaluation of evaluations) {
      const score = evaluation.candidateScores.find(
        (candidate) => candidate.candidateId === draft.id
      );
      if (!score) {
        continue;
      }

      const weight = evaluation.judgeModelId === draft.modelId ? selfScoreWeight : peerScoreWeight;
      weightedTotals.push({ score: score.total, weight });

      for (const criterion of criteria) {
        const criterionScore = score.scores[criterion];
        if (criterionScore === undefined) {
          continue;
        }
        weightedCriteria[criterion] ??= [];
        weightedCriteria[criterion].push({ score: criterionScore, weight });
      }
    }

    const scores: Partial<Record<EvaluationCriterion, number>> = {};
    for (const criterion of criteria) {
      const values = weightedCriteria[criterion] ?? [];
      if (values.length > 0) {
        scores[criterion] = weightedAverage(values);
      }
    }

    return {
      candidateId: draft.id,
      modelId: draft.modelId,
      scores,
      weightedTotal: weightedAverage(weightedTotals)
    };
  });

  candidates.sort((left, right) => right.weightedTotal - left.weightedTotal);
  const first = candidates[0];
  const second = candidates[1];
  const difference = first && second ? first.weightedTotal - second.weightedTotal : Infinity;
  const tie = Number.isFinite(difference) ? Math.abs(difference) < Number.EPSILON : false;
  const significantDifference = difference >= significantDifferenceThreshold;

  return {
    candidates,
    winner: first?.candidateId,
    tie,
    significantDifference
  };
}

export function summarizeAggregation(aggregation: AggregatedEvaluation): string {
  return JSON.stringify(aggregation, null, 2);
}

function weightedAverage(values: Array<{ score: number; weight: number }>): number {
  const denominator = values.reduce((sum, value) => sum + value.weight, 0);
  if (denominator === 0) {
    return 0;
  }
  const numerator = values.reduce((sum, value) => sum + value.score * value.weight, 0);
  return round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
