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

export async function runMultiDraftRefinement(config: RunConfig): Promise<RunResult> {
  const normalized = normalizeConfig(config);
  const startedAt = new Date().toISOString();
  const emit = (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]): void => {
    normalized.onEvent?.(event);
  };

  const rounds: RoundResult[] = [];
  throwIfAborted(normalized.signal);
  emit({ type: "round_start", round: 0 });
  let currentDrafts = await createInitialDrafts(normalized);
  for (const draft of currentDrafts) {
    emit({ type: "draft_created", draft });
  }
  rounds.push({ round: 0, drafts: currentDrafts });
  emit({ type: "round_complete", round: 0, drafts: currentDrafts });

  for (let round = 1; round <= normalized.rounds; round += 1) {
    throwIfAborted(normalized.signal);
    emit({ type: "round_start", round });
    currentDrafts = await refineDrafts(normalized, currentDrafts, round);
    for (const draft of currentDrafts) {
      emit({ type: "draft_created", draft });
    }
    rounds.push({ round, drafts: currentDrafts });
    emit({ type: "round_complete", round, drafts: currentDrafts });
  }

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

  const finishedAt = new Date().toISOString();
  let outputDir: string | undefined;
  if (normalized.saveArtifacts) {
    outputDir = await writeRunArtifacts({
      config: {
        task: normalized.task,
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
    finalMode: config.finalMode ?? "choose_best",
    selfScoreWeight: config.selfScoreWeight ?? 0.5,
    peerScoreWeight: config.peerScoreWeight ?? 1,
    outputDir: config.outputDir,
    synthesisThreshold: config.synthesisThreshold ?? 0.3,
    saveArtifacts: config.saveArtifacts ?? true,
    signal: config.signal,
    onEvent: config.onEvent
  };
}

async function createInitialDrafts(config: NormalizedRunConfig): Promise<Draft[]> {
  return Promise.all(
    config.models.map(async (model) => {
      const output = await model.generate({
        prompt: initialPrompt(config.task),
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal: config.signal
      });

      return createDraft(model.id, 0, output.text);
    })
  );
}

async function refineDrafts(
  config: NormalizedRunConfig,
  currentDrafts: Draft[],
  round: number
): Promise<Draft[]> {
  return Promise.all(
    currentDrafts.map(async (draft) => {
      const model = findModel(config.models, draft.modelId);
      const otherDrafts = currentDrafts.filter((other) => other.modelId !== draft.modelId);
      const output = await model.generate({
        prompt: refinementPrompt(config.task, draft, otherDrafts),
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal: config.signal
      });
      const parsed = extractImprovedAnswer(output.text);

      return createDraft(model.id, round, parsed.answer, parsed.notes);
    })
  );
}

async function evaluateFinalDrafts(
  config: NormalizedRunConfig,
  finalDrafts: Draft[],
  emit: (event: Parameters<NonNullable<RunConfig["onEvent"]>>[0]) => void
): Promise<EvaluationResult[]> {
  return Promise.all(
    config.models.map(async (model) => {
      throwIfAborted(config.signal);
      emit({ type: "evaluation_start", judgeModelId: model.id });
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
    })
  );
}

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

function findModel(models: ModelAdapter[], modelId: string): ModelAdapter {
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`Model adapter not found for ${modelId}.`);
  }
  return model;
}

function ensureUniqueModelIds(models: ModelAdapter[]): void {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`Duplicate model id: ${model.id}.`);
    }
    ids.add(model.id);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Multi-draft refinement was aborted.");
  }
}
