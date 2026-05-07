// ---------------------------------------------------------------------------
// Public type system for the multi-draft refinement pipeline.
//
// The pipeline takes a single task, asks several LLMs to draft an answer,
// asks them to refine each other's drafts for N rounds, then asks them to
// judge the final drafts and produces one winning (or synthesized) answer.
//
// Most of the types in this file describe the data that flows between those
// phases: model adapters, drafts, evaluations, aggregated scores, and the
// final RunResult that the orchestrator returns.
// ---------------------------------------------------------------------------

/**
 * Criteria used by judges to score candidate answers.
 *
 * Each criterion produces an integer score 0..10 in the judge's response.
 * The active set is configured per-run via `RunConfig.evaluationCriteria`;
 * the default subset is exported as `DEFAULT_EVALUATION_CRITERIA` below.
 */
export type EvaluationCriterion =
  | "accuracy"
  | "completeness"
  | "usefulness"
  | "clarity"
  | "goal_fit"
  | "specificity"
  | "risk_control";

/**
 * How the orchestrator should produce the final answer after the last round.
 *
 * - `choose_best`           – return the winning draft text as-is.
 * - `synthesize`            – always run a synthesis pass over all drafts.
 * - `choose_or_synthesize`  – return the winner if scores diverge clearly,
 *                             otherwise synthesize (used when judges tie or
 *                             the gap is below `synthesisThreshold`).
 */
export type FinalMode = "choose_best" | "synthesize" | "choose_or_synthesize";

/**
 * Single request payload sent to a model adapter's `generate()`.
 *
 * `signal` lets the orchestrator cancel mid-flight when the run is aborted.
 */
export type ModelInput = {
  prompt: string;
  system?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * Result returned from a model adapter's `generate()`.
 *
 * `raw` is the provider-specific response object kept around for debugging
 * and for tests that want to assert against the underlying SDK shape.
 */
export type ModelOutput = {
  text: string;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  raw?: unknown;
};

/**
 * Minimal contract every model adapter must satisfy.
 *
 * Adapters wrap one underlying model (HTTP API, CLI process, mock, etc.)
 * and expose a uniform text-in/text-out `generate()` method so the
 * orchestrator can treat all models the same way.
 */
export interface ModelAdapter {
  id: string;
  label?: string | undefined;
  generate(input: ModelInput): Promise<ModelOutput>;
}

/**
 * One draft produced by one model in one round.
 *
 * `id` is unique across the whole run (model id + round + random suffix).
 * `notes` is filled when the model returned a "Changes Made" section
 * during a refinement round — it explains what the model improved.
 */
export type Draft = {
  id: string;
  modelId: string;
  round: number;
  text: string;
  notes?: string | undefined;
  createdAt: string;
};

/** All drafts produced in a single round (round 0 is the initial drafts). */
export type RoundResult = {
  round: number;
  drafts: Draft[];
};

/**
 * Top-level configuration for `runMultiDraftRefinement`.
 *
 * Most fields are optional and fall back to defaults inside `normalizeConfig`
 * in the orchestrator. Important knobs:
 *
 * - `rounds`              – number of refinement rounds AFTER the initial draft.
 * - `selfScoreWeight`     – weight applied when a model judges its own draft
 *                           (default 0.5; lower than peer weight to dampen bias).
 * - `peerScoreWeight`     – weight applied when a model judges another model's
 *                           draft (default 1).
 * - `synthesisThreshold`  – minimum score gap between top two candidates that
 *                           is considered "significant" enough to skip synthesis
 *                           in `choose_or_synthesize` mode.
 * - `saveArtifacts`       – when true, every draft, evaluation, and the final
 *                           answer are written under `outputDir` (or `.runs/`).
 */
export type RunConfig = {
  task: string;
  models: ModelAdapter[];
  rounds?: number | undefined;
  maxRounds?: number | undefined;
  evaluationCriteria?: EvaluationCriterion[] | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  finalMode?: FinalMode | undefined;
  selfScoreWeight?: number | undefined;
  peerScoreWeight?: number | undefined;
  outputDir?: string | undefined;
  synthesisThreshold?: number | undefined;
  saveArtifacts?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: RunEvent) => void) | undefined;
};

/**
 * One judge's score for one candidate draft.
 *
 * Produced by `parseEvaluationText` from a judge's markdown response.
 * `total` is either explicitly stated by the judge (`Total: X/10`) or
 * computed as the average of the per-criterion scores.
 */
export type CandidateScore = {
  candidateId: string;
  modelId?: string | undefined;
  scores: Partial<Record<EvaluationCriterion, number>>;
  total: number;
  strengths?: string[] | undefined;
  weaknesses?: string[] | undefined;
  explanation?: string | undefined;
};

/**
 * Full evaluation produced by one judge model — the raw markdown plus the
 * structured per-candidate scores parsed out of it.
 */
export type EvaluationResult = {
  judgeModelId: string;
  text: string;
  candidateScores: CandidateScore[];
  bestCandidateId?: string | undefined;
  reason?: string | undefined;
};

/**
 * One candidate after all judges' scores have been aggregated together
 * with self/peer weights applied. `weightedTotal` is what the orchestrator
 * sorts by to pick the winner.
 */
export type AggregatedCandidate = {
  candidateId: string;
  modelId: string;
  scores: Partial<Record<EvaluationCriterion, number>>;
  weightedTotal: number;
};

/**
 * Cross-judge aggregation summary.
 *
 * - `winner`                  – id of the highest-scoring candidate (if any).
 * - `tie`                     – top two candidates have indistinguishable scores.
 * - `significantDifference`   – top two candidates differ by at least
 *                               `synthesisThreshold` (used by
 *                               `choose_or_synthesize` to decide whether to
 *                               trust the winner or synthesize a new answer).
 */
export type AggregatedEvaluation = {
  candidates: AggregatedCandidate[];
  winner?: string | undefined;
  tie: boolean;
  significantDifference: boolean;
};

/**
 * Everything `runMultiDraftRefinement` returns to the caller.
 *
 * This is also what the CLI prints / serializes to `run.json` when artifacts
 * are saved. Consumers can introspect every round, every judge's reasoning,
 * and the aggregated decision in addition to the headline `finalAnswer`.
 */
export type RunResult = {
  task: string;
  rounds: RoundResult[];
  finalDrafts: Draft[];
  evaluations: EvaluationResult[];
  aggregatedEvaluation: AggregatedEvaluation;
  winner?: Draft | undefined;
  finalAnswer: string;
  outputDir?: string | undefined;
  startedAt: string;
  finishedAt: string;
};

/**
 * Progress events emitted to `RunConfig.onEvent` while a run is in flight.
 *
 * Used by the CLI to print live progress and by SDK consumers to drive
 * their own UIs. Draft events include per-model start, success, and failure
 * signals so long-running local CLI adapters are visible while they run.
 * Events fire in pipeline order:
 * round_start → draft_start* → draft_created* → round_complete → … →
 * evaluation_start → evaluation_complete → (synthesis_start) →
 * (artifacts_saved) → run_complete.
 */
export type RunEvent =
  | { type: "round_start"; round: number }
  | { type: "draft_start"; modelId: string; round: number; phase: "initial" | "refinement" }
  | { type: "draft_created"; draft: Draft }
  | {
      type: "draft_failed";
      modelId: string;
      round: number;
      phase: "initial" | "refinement";
      error: Error;
    }
  | { type: "round_complete"; round: number; drafts: Draft[] }
  | { type: "evaluation_start"; judgeModelId: string }
  | { type: "evaluation_complete"; result: EvaluationResult }
  | { type: "evaluation_failed"; judgeModelId: string; error: Error }
  | { type: "synthesis_start" }
  | { type: "artifacts_saved"; outputDir: string }
  | { type: "run_complete"; winner?: string | undefined };

/**
 * Default criteria used when `RunConfig.evaluationCriteria` is omitted.
 *
 * `specificity` and `risk_control` are deliberately left out of the default
 * set — they are useful for technical/operational tasks but tend to bias
 * judges on creative or open-ended prompts. Opt in explicitly when needed.
 */
export const DEFAULT_EVALUATION_CRITERIA: EvaluationCriterion[] = [
  "accuracy",
  "completeness",
  "usefulness",
  "clarity",
  "goal_fit"
];
