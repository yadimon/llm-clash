// ---------------------------------------------------------------------------
// Cross-judge scoring aggregation.
//
// Every model in the run acts as both author (producing drafts) AND judge
// (scoring everyone's final draft). This module merges all those judge
// scorecards into a single ranking so the orchestrator can pick a winner
// or detect that the result is too close to call.
//
// Two weights matter:
//
//   - selfScoreWeight  – applied when a judge scores ITS OWN draft.
//                        Defaults to 0.5; lower than peer weight to dampen
//                        the natural bias of a model toward its own writing.
//   - peerScoreWeight  – applied when a judge scores SOMEONE ELSE's draft.
//                        Defaults to 1.0.
//
// `significantDifferenceThreshold` controls when a top-1 vs top-2 gap is
// considered meaningful. The orchestrator uses this in
// `choose_or_synthesize` mode to decide whether to trust the winner or fuse
// the strongest drafts together via a synthesis pass.
// ---------------------------------------------------------------------------

import type {
  AggregatedEvaluation,
  Draft,
  EvaluationCriterion,
  EvaluationResult
} from "./types.js";

/**
 * Fold every judge's `EvaluationResult` into a single `AggregatedEvaluation`.
 *
 * For each candidate draft:
 *   1. Collect every judge's per-criterion score and overall total for it.
 *   2. Tag each entry with self-weight or peer-weight based on whether the
 *      judge wrote the draft.
 *   3. Compute a weighted average per criterion AND a single
 *      `weightedTotal` used for ranking.
 *
 * The returned `tie` flag is set when the top two `weightedTotal` values are
 * within `Number.EPSILON`. `significantDifference` is set when the gap meets
 * `significantDifferenceThreshold` (default 0.3 on a 0..10 scale).
 */
export function aggregateEvaluations(
  finalDrafts: Draft[],
  evaluations: EvaluationResult[],
  criteria: EvaluationCriterion[],
  selfScoreWeight: number,
  peerScoreWeight: number,
  significantDifferenceThreshold = 0.3
): AggregatedEvaluation {
  const candidates = finalDrafts.map((draft) => {
    // Buckets we will reduce into weighted averages at the end.
    const weightedTotals: Array<{ score: number; weight: number }> = [];
    const weightedCriteria: Record<string, Array<{ score: number; weight: number }>> = {};

    for (const evaluation of evaluations) {
      const score = evaluation.candidateScores.find(
        (candidate) => candidate.candidateId === draft.id
      );
      // Some judges may fail to score every candidate (parser miss, model
      // skipped a section, etc.) — skip silently rather than fabricating zeros.
      if (!score) {
        continue;
      }

      // Self-vs-peer weighting: same modelId on both sides means the judge
      // is scoring its own draft, so dampen its influence.
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

  // Highest weightedTotal first; the head of the list is the winner.
  candidates.sort((left, right) => right.weightedTotal - left.weightedTotal);
  const first = candidates[0];
  const second = candidates[1];
  // With only one candidate there is nothing to compare against — treat the
  // gap as infinitely large so it's never considered a tie.
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

/**
 * Pretty-print the aggregation as JSON. The synthesis prompt embeds this so
 * the synthesizing model can see exactly how judges scored the candidates.
 */
export function summarizeAggregation(aggregation: AggregatedEvaluation): string {
  return JSON.stringify(aggregation, null, 2);
}

/**
 * Standard weighted mean, with a guard for the all-zero-weights edge case
 * (returns 0 instead of NaN). Result is rounded to 3 decimals to keep the
 * persisted JSON readable.
 */
function weightedAverage(values: Array<{ score: number; weight: number }>): number {
  const denominator = values.reduce((sum, value) => sum + value.weight, 0);
  if (denominator === 0) {
    return 0;
  }
  const numerator = values.reduce((sum, value) => sum + value.score * value.weight, 0);
  return round(numerator / denominator);
}

/** Round to 3 decimal places — enough resolution, easy to read in artifacts. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
