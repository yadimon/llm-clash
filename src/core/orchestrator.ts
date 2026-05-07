// ---------------------------------------------------------------------------
// Multi-draft refinement orchestrator.
//
// This is the heart of the package. It runs the full pipeline:
//
//   1. INITIAL DRAFTS  – every model produces an answer to the task in parallel
//                        (this is "round 0").
//   2. REFINEMENT      – for `rounds` iterations, every model sees its own
//                        previous draft plus the other models' latest drafts
//                        and produces an improved version.
//   3. EVALUATION      – every model becomes a judge and scores the final
//                        drafts against `evaluationCriteria`.
//   4. AGGREGATION     – judges' scores are merged with self/peer weights to
//                        pick a winner (or detect a tie).
//   5. FINAL ANSWER    – depending on `finalMode`, return the winner verbatim
//                        or run a synthesis pass that fuses the best parts.
//   6. ARTIFACTS       – when enabled, write every draft, evaluation, and the
//                        final answer to disk for later inspection.
//
// Progress is reported through `RunConfig.onEvent` so a CLI or UI can stream
// updates while the pipeline runs.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { evaluationPrompt, initialPrompt, refinementPrompt, synthesisPrompt } from "./prompts.js";
import { extractImprovedAnswer, parseEvaluationText } from "./parser.js";
import { aggregateEvaluations, summarizeAggregation } from "./scoring.js";
import { safeFileName, writeRunArtifacts } from "./storage.js";
import type {
  Draft,
  EvaluationResult,
  ModelAdapter,
  RoundResult,
  RunConfig,
  RunResult
} from "./types.js";
import { DEFAULT_EVALUATION_CRITERIA } from "./types.js";

/**
 * Internal "all-required" version of `RunConfig` produced by `normalizeConfig`.
 * Every optional field on `RunConfig` either has a default applied here or
 * stays explicitly optional with `?` — that way the rest of this file never
 * needs to repeat the default values inline.
 */
type NormalizedRunConfig = {
  task: string;
  models: ModelAdapter[];
  rounds: number;
  maxRounds: number;
  evaluationCriteria: NonNullable<RunConfig["evaluationCriteria"]>;
  finalMode: NonNullable<RunConfig["finalMode"]>;
  selfScoreWeight: number;
  peerScoreWeight: number;
  synthesisThreshold: number;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  outputDir?: string | undefined;
  saveArtifacts: boolean;
  signal?: AbortSignal | undefined;
  onEvent?: RunConfig["onEvent"];
};

/**
 * Run the full multi-draft refinement pipeline (see file header for stages).
 *
 * Returns a `RunResult` containing every intermediate artifact (per-round
 * drafts, judge evaluations, aggregated scores) plus the final answer.
 * Throws if `task` is empty, no models are provided, or the run is aborted
 * via `RunConfig.signal`.
 */
export async function runMultiDraftRefinement(config: RunConfig): Promise<RunResult> {
  const normalized = normalizeConfig(config);
  const startedAt = new Date().toISOString();

  // Local helper so we don't repeat `?.()` everywhere; resolves to a no-op
  // when the caller didn't pass an `onEvent` listener.
  const emit = (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]): void => {
    normalized.onEvent?.(event);
  };

  // ----- Phase 1: initial drafts (round 0) ----------------------------------
  const rounds: RoundResult[] = [];
  throwIfAborted(normalized.signal);
  emit({ type: "round_start", round: 0 });
  let currentDrafts = await createInitialDrafts(normalized, emit);
  rounds.push({ round: 0, drafts: currentDrafts });
  emit({ type: "round_complete", round: 0, drafts: currentDrafts });

  // ----- Phase 2: refinement rounds -----------------------------------------
  // Each iteration replaces `currentDrafts` with the next-generation drafts;
  // the loop is sequential because round N needs the output of round N-1.
  for (let round = 1; round <= normalized.rounds; round += 1) {
    throwIfAborted(normalized.signal);
    emit({ type: "round_start", round });
    currentDrafts = await refineDrafts(normalized, currentDrafts, round, emit);
    rounds.push({ round, drafts: currentDrafts });
    emit({ type: "round_complete", round, drafts: currentDrafts });
  }

  // ----- Phase 3 + 4: judges score the final drafts and we aggregate --------
  const finalDrafts = currentDrafts;
  const evaluations = await evaluateFinalDrafts(normalized, finalDrafts, emit);
  const aggregatedEvaluation = aggregateEvaluations(
    finalDrafts,
    evaluations,
    normalized.evaluationCriteria,
    normalized.selfScoreWeight,
    normalized.peerScoreWeight,
    normalized.synthesisThreshold
  );

  // ----- Phase 5: final answer (winner or synthesis) ------------------------
  const winner = aggregatedEvaluation.winner
    ? finalDrafts.find((draft) => draft.id === aggregatedEvaluation.winner)
    : undefined;
  const finalAnswer = await createFinalAnswer(
    normalized,
    finalDrafts,
    winner,
    aggregatedEvaluation,
    evaluations,
    emit
  );

  // ----- Phase 6: optionally persist everything to disk ---------------------
  const finishedAt = new Date().toISOString();
  let outputDir: string | undefined;
  if (normalized.saveArtifacts) {
    outputDir = await writeRunArtifacts({
      config: {
        task: normalized.task,
        // Strip the actual adapter instances; we only persist their identity.
        models: normalized.models.map((model) => ({ id: model.id, label: model.label })),
        rounds: normalized.rounds,
        evaluationCriteria: normalized.evaluationCriteria,
        temperature: normalized.temperature,
        maxTokens: normalized.maxTokens,
        finalMode: normalized.finalMode,
        selfScoreWeight: normalized.selfScoreWeight,
        peerScoreWeight: normalized.peerScoreWeight
      },
      rounds,
      finalDrafts,
      evaluations,
      aggregatedEvaluation,
      finalAnswer,
      outputDir: normalized.outputDir,
      startedAt,
      finishedAt
    });
    emit({ type: "artifacts_saved", outputDir });
  }

  emit({ type: "run_complete", winner: aggregatedEvaluation.winner });

  return {
    task: normalized.task,
    rounds,
    finalDrafts,
    evaluations,
    aggregatedEvaluation,
    winner,
    finalAnswer,
    outputDir,
    startedAt,
    finishedAt
  };
}

/**
 * Validate `RunConfig` and apply defaults so the rest of the orchestrator can
 * trust that every relevant field is populated.
 *
 * Defaults of note:
 * - `rounds`              = 2  (initial draft + 2 refinement passes)
 * - `maxRounds`           = 4  (hard ceiling to prevent runaway loops)
 * - `finalMode`           = "choose_or_synthesize" (synthesize on tie/close gap)
 * - `selfScoreWeight`     = 0.5 (judges score themselves at half weight)
 * - `peerScoreWeight`     = 1   (full weight for peer scoring)
 * - `synthesisThreshold`  = 0.3 (gap below this counts as "no clear winner")
 * - `saveArtifacts`       = true
 */
function normalizeConfig(config: RunConfig): NormalizedRunConfig {
  if (!config.task.trim()) {
    throw new Error("RunConfig.task is required.");
  }
  if (config.models.length === 0) {
    throw new Error("RunConfig.models must include at least one model adapter.");
  }

  const maxRounds = config.maxRounds ?? 4;
  const rounds = config.rounds ?? 2;
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new Error("RunConfig.rounds must be a non-negative integer.");
  }
  if (rounds > maxRounds) {
    throw new Error(`RunConfig.rounds must be <= ${maxRounds}.`);
  }

  ensureUniqueModelIds(config.models);

  return {
    task: config.task,
    models: config.models,
    rounds,
    maxRounds,
    evaluationCriteria: config.evaluationCriteria ?? DEFAULT_EVALUATION_CRITERIA,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    finalMode: config.finalMode ?? "choose_or_synthesize",
    selfScoreWeight: config.selfScoreWeight ?? 0.5,
    peerScoreWeight: config.peerScoreWeight ?? 1,
    outputDir: config.outputDir,
    synthesisThreshold: config.synthesisThreshold ?? 0.3,
    saveArtifacts: config.saveArtifacts ?? true,
    signal: config.signal,
    onEvent: config.onEvent
  };
}

/**
 * Phase 1 — fan out to every model and collect their initial answers in
 * parallel. There are no peer drafts to look at yet, so each model only sees
 * the bare task via `initialPrompt`.
 */
async function createInitialDrafts(
  config: NormalizedRunConfig,
  emit: (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]) => void
): Promise<Draft[]> {
  return Promise.all(
    config.models.map(async (model) => {
      emit({ type: "draft_start", modelId: model.id, round: 0, phase: "initial" });
      try {
        const output = await model.generate({
          prompt: initialPrompt(config.task),
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          signal: config.signal
        });

        const draft = createDraft(model.id, 0, output.text);
        emit({ type: "draft_created", draft });
        return draft;
      } catch (error) {
        emit({
          type: "draft_failed",
          modelId: model.id,
          round: 0,
          phase: "initial",
          error: toError(error)
        });
        throw error;
      }
    })
  );
}

/**
 * Phase 2 — one refinement round. Each model rewrites its OWN previous draft
 * after seeing the other models' latest attempts. The model also returns a
 * "Changes Made" section that we capture as `Draft.notes` for transparency.
 */
async function refineDrafts(
  config: NormalizedRunConfig,
  currentDrafts: Draft[],
  round: number,
  emit: (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]) => void
): Promise<Draft[]> {
  return Promise.all(
    currentDrafts.map(async (draft) => {
      const model = findModel(config.models, draft.modelId);
      // Show the model only OTHER models' drafts so it isn't biased toward
      // simply re-emitting its own previous output.
      const otherDrafts = currentDrafts.filter((other) => other.modelId !== draft.modelId);
      emit({ type: "draft_start", modelId: model.id, round, phase: "refinement" });
      try {
        const output = await model.generate({
          prompt: refinementPrompt(config.task, draft, otherDrafts),
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          signal: config.signal
        });
        const parsed = extractImprovedAnswer(output.text);

        const nextDraft = createDraft(model.id, round, parsed.answer, parsed.notes);
        emit({ type: "draft_created", draft: nextDraft });
        return nextDraft;
      } catch (error) {
        emit({
          type: "draft_failed",
          modelId: model.id,
          round,
          phase: "refinement",
          error: toError(error)
        });
        throw error;
      }
    })
  );
}

/**
 * Phase 3 — every model judges the final drafts in parallel.
 *
 * Judges run with `temperature: 0` so scores are as deterministic as the
 * underlying model allows. The raw markdown response is kept on
 * `EvaluationResult.text` and the structured scores are parsed out by
 * `parseEvaluationText`.
 */
async function evaluateFinalDrafts(
  config: NormalizedRunConfig,
  finalDrafts: Draft[],
  emit: (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]) => void
): Promise<EvaluationResult[]> {
  return Promise.all(
    config.models.map(async (model) => {
      throwIfAborted(config.signal);
      emit({ type: "evaluation_start", judgeModelId: model.id });
      try {
        const output = await model.generate({
          prompt: evaluationPrompt(config.task, finalDrafts, config.evaluationCriteria),
          temperature: 0,
          maxTokens: config.maxTokens,
          signal: config.signal
        });

        const result = parseEvaluationText(
          output.text,
          finalDrafts,
          config.evaluationCriteria,
          model.id
        );
        emit({ type: "evaluation_complete", result });
        return result;
      } catch (error) {
        emit({ type: "evaluation_failed", judgeModelId: model.id, error: toError(error) });
        throw error;
      }
    })
  );
}

/**
 * Phase 5 — pick or synthesize the final answer.
 *
 * Decision matrix:
 *
 *   finalMode = "choose_best"           → return winner draft as-is.
 *   finalMode = "synthesize"            → always synthesize from all drafts.
 *   finalMode = "choose_or_synthesize"  → synthesize only if judges tied or
 *                                         the gap was below the significance
 *                                         threshold; otherwise return winner.
 *
 * Synthesis uses the FIRST model in `config.models` as the synthesizer
 * (callers can put their preferred "summarizer" first to control this).
 */
async function createFinalAnswer(
  config: NormalizedRunConfig,
  finalDrafts: Draft[],
  winner: Draft | undefined,
  aggregation: RunResult["aggregatedEvaluation"],
  evaluations: EvaluationResult[],
  emit: (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]) => void
): Promise<string> {
  if (config.finalMode === "choose_best") {
    return winner?.text ?? finalDrafts[0]?.text ?? "";
  }

  const shouldSynthesize =
    config.finalMode === "synthesize" || aggregation.tie || !aggregation.significantDifference;

  if (!shouldSynthesize) {
    return winner?.text ?? finalDrafts[0]?.text ?? "";
  }

  const synthesisModel = config.models[0];
  if (!synthesisModel) {
    return winner?.text ?? finalDrafts[0]?.text ?? "";
  }

  emit({ type: "synthesis_start" });
  throwIfAborted(config.signal);
  const output = await synthesisModel.generate({
    prompt: synthesisPrompt(
      config.task,
      finalDrafts,
      `${summarizeAggregation(aggregation)}\n\nRaw evaluation count: ${evaluations.length}`
    ),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    signal: config.signal
  });

  return output.text;
}

/**
 * Build a `Draft` value object. The id encodes model + round + a short uuid
 * so it remains unique even when the same model produces drafts across many
 * rounds and so it is safe to use directly as a filename suffix.
 */
function createDraft(modelId: string, round: number, text: string, notes?: string): Draft {
  const suffix = `${safeFileName(modelId)}-round-${round}-${randomUUID().slice(0, 8)}`;
  return {
    id: suffix,
    modelId,
    round,
    text: text.trim(),
    notes: notes?.trim(),
    createdAt: new Date().toISOString()
  };
}

/** Look up an adapter by id. Throws — used for invariant checks during refinement. */
function findModel(models: ModelAdapter[], modelId: string): ModelAdapter {
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Model adapter not found for ${modelId}.`);
  }
  return model;
}

/**
 * Reject configs that contain duplicate model ids. Duplicate ids would make
 * downstream artifacts collide on disk and aggregation ambiguous (we couldn't
 * tell which "openai:gpt-4.1" produced which draft).
 */
function ensureUniqueModelIds(models: ModelAdapter[]): void {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`Duplicate model id: ${model.id}.`);
    }
    ids.add(model.id);
  }
}

/** Cooperative cancellation point. Called between every blocking step. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Multi-draft refinement was aborted.");
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
