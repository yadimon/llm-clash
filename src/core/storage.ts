// ---------------------------------------------------------------------------
// Run artifact persistence.
//
// When `RunConfig.saveArtifacts` is true, the orchestrator calls
// `writeRunArtifacts` to drop a complete inspectable record of the run on
// disk. Default location is `.runs/<timestamp>/` (gitignored). Layout:
//
//   <outputDir>/
//     config.yaml                     – snapshot of the normalized run config
//     task.md                         – the task text as plain markdown
//     rounds/
//       round-0/
//         <safe-model-id>.md          – initial draft for each model
//       round-1/
//         <safe-model-id>.md          – first refinement, etc.
//       ...
//     evaluation/
//       <safe-judge-id>.md            – raw markdown judgment from each judge
//       aggregated.json               – cross-judge weighted scores + winner
//     final.md                        – the final answer string
//     run.json                        – complete machine-readable record of
//                                       the run (everything above, denormalized)
//
// File names are run through `safeFileName` so model ids containing slashes,
// colons, etc. become valid file names on every OS.
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type {
  AggregatedEvaluation,
  Draft,
  EvaluationResult,
  RoundResult,
  RunConfig
} from "./types.js";

/**
 * Everything `writeRunArtifacts` needs in order to serialize a complete run.
 *
 * `config` is the slim "as persisted" view (no live adapter instances), and
 * `outputDir` is optional — when omitted, a timestamped directory under
 * `.runs/` is used.
 */
export type WriteRunArtifactsInput = {
  config: RequiredRunStorageConfig;
  rounds: RoundResult[];
  finalDrafts: Draft[];
  evaluations: EvaluationResult[];
  aggregatedEvaluation: AggregatedEvaluation;
  finalAnswer: string;
  outputDir?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
};

/**
 * Subset of `RunConfig` that is safe to persist.
 *
 * Live `ModelAdapter` instances are stripped and replaced by `{ id, label }`
 * descriptors — adapters are not serializable (they hold closures, fetch
 * implementations, etc.) and we only need their identity to reconstruct the
 * run later.
 */
export type RequiredRunStorageConfig = Pick<
  RunConfig,
  | "task"
  | "rounds"
  | "evaluationCriteria"
  | "temperature"
  | "maxTokens"
  | "finalMode"
  | "selfScoreWeight"
  | "peerScoreWeight"
> & {
  models: Array<{ id: string; label?: string | undefined }>;
};

/**
 * Resolve the artifact directory for a run: the caller-provided path, or a
 * fresh timestamped directory under `.runs/`. Exposed so the orchestrator
 * can pin the directory BEFORE the run starts and stream artifacts into it
 * incrementally.
 */
export function resolveRunOutputDir(outputDir?: string | undefined): string {
  return outputDir ?? join(".runs", timestampForPath(new Date()));
}

/**
 * Write the top-level metadata files (`config.yaml` + `task.md`). Called
 * once at run start so even a crash during round 0 leaves an inspectable
 * record of what was attempted.
 */
export async function writeRunMetadata(
  outputDir: string,
  config: RequiredRunStorageConfig
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "config.yaml"), YAML.stringify(config), "utf8");
  await writeFile(join(outputDir, "task.md"), config.task, "utf8");
}

/**
 * Write one round's draft files (one markdown file per model). Called by the
 * orchestrator as soon as each round completes so a later crash (evaluation,
 * synthesis) cannot lose finished drafts.
 */
export async function writeRoundArtifacts(outputDir: string, round: RoundResult): Promise<void> {
  const roundDir = join(outputDir, "rounds", `round-${round.round}`);
  await mkdir(roundDir, { recursive: true });
  await Promise.all(
    round.drafts.map((draft) => {
      return writeFile(
        join(roundDir, `${safeFileName(draft.modelId)}.md`),
        draftToMarkdown(draft),
        "utf8"
      );
    })
  );
}

/**
 * Write one judge's raw markdown judgment. Called by the orchestrator as soon
 * as the judge finishes so completed judgments survive a crash in another
 * judge or in synthesis.
 */
export async function writeEvaluationArtifact(
  outputDir: string,
  evaluation: EvaluationResult
): Promise<void> {
  const evaluationDir = join(outputDir, "evaluation");
  await mkdir(evaluationDir, { recursive: true });
  await writeFile(
    join(evaluationDir, `${safeFileName(evaluation.judgeModelId)}.md`),
    evaluation.text,
    "utf8"
  );
}

/**
 * Write the full artifact tree for a run and return the directory it was
 * written to. See the module-level header for the on-disk layout.
 *
 * Files inside a single subdirectory (drafts inside a round, judges inside
 * `evaluation/`) are written in parallel via `Promise.all`; subdirectories
 * themselves are processed sequentially because each one depends on its
 * parent existing.
 *
 * Idempotent with respect to the incremental writers above: when the
 * orchestrator already streamed rounds/evaluations into the same directory,
 * this rewrites those files with identical content and adds the summary
 * files (`aggregated.json`, `final.md`, `run.json`).
 */
export async function writeRunArtifacts(input: WriteRunArtifactsInput): Promise<string> {
  const outputDir = resolveRunOutputDir(input.outputDir);

  // Top-level metadata files.
  await writeRunMetadata(outputDir, input.config);

  // Per-round draft files (one markdown file per model per round).
  for (const round of input.rounds) {
    await writeRoundArtifacts(outputDir, round);
  }

  // Judge evaluations (raw markdown) plus the aggregated cross-judge JSON.
  for (const evaluation of input.evaluations) {
    await writeEvaluationArtifact(outputDir, evaluation);
  }
  const evaluationDir = join(outputDir, "evaluation");
  await mkdir(evaluationDir, { recursive: true });
  await writeFile(
    join(evaluationDir, "aggregated.json"),
    JSON.stringify(input.aggregatedEvaluation, null, 2),
    "utf8"
  );

  // Final answer (human-friendly) plus the full run record (machine-friendly).
  await writeFile(join(outputDir, "final.md"), input.finalAnswer, "utf8");
  await writeFile(
    join(outputDir, "run.json"),
    JSON.stringify(
      {
        task: input.config.task,
        rounds: input.rounds,
        finalDrafts: input.finalDrafts,
        evaluations: input.evaluations,
        aggregatedEvaluation: input.aggregatedEvaluation,
        finalAnswer: input.finalAnswer,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt
      },
      null,
      2
    ),
    "utf8"
  );

  return outputDir;
}

/**
 * Convert any string into a portable file name fragment.
 *
 * Lowercases, collapses runs of unsafe characters into `-`, trims leading
 * and trailing dashes, and caps the length at 100 chars so deeply qualified
 * model ids like `openrouter:anthropic/claude-3.5-sonnet` become the safe
 * file-system-friendly `openrouter-anthropic-claude-3.5-sonnet`.
 *
 * Re-exported (and used) by the orchestrator when generating draft ids so
 * the same identifier survives a round-trip to disk.
 */
export function safeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

/**
 * Render one draft as a markdown file with a YAML front-matter block. The
 * front-matter keeps machine-readable metadata at the top while the body
 * stays human-readable for review.
 */
function draftToMarkdown(draft: Draft): string {
  const notes = draft.notes ? `\n\n# Changes Made\n\n${draft.notes}\n` : "";
  return `---
id: ${draft.id}
modelId: ${draft.modelId}
round: ${draft.round}
createdAt: ${draft.createdAt}
---

${draft.text}${notes}`;
}

/**
 * Build a sortable, file-system-safe timestamp like `2026-05-03T20-35-22`.
 * Colons would break paths on Windows; milliseconds drop because seconds
 * are already plenty of resolution for one run per process.
 */
function timestampForPath(date: Date): string {
  return date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "");
}
