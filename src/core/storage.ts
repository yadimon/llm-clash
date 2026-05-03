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

export async function writeRunArtifacts(input: WriteRunArtifactsInput): Promise<string> {
  const outputDir = input.outputDir ?? join(".runs", timestampForPath(new Date()));
  await mkdir(outputDir, { recursive: true });

  await writeFile(join(outputDir, "config.yaml"), YAML.stringify(input.config), "utf8");
  await writeFile(join(outputDir, "task.md"), input.config.task, "utf8");

  for (const round of input.rounds) {
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

  const evaluationDir = join(outputDir, "evaluation");
  await mkdir(evaluationDir, { recursive: true });
  await Promise.all(
    input.evaluations.map((evaluation) => {
      return writeFile(
        join(evaluationDir, `${safeFileName(evaluation.judgeModelId)}.md`),
        evaluation.text,
        "utf8"
      );
    })
  );
  await writeFile(
    join(evaluationDir, "aggregated.json"),
    JSON.stringify(input.aggregatedEvaluation, null, 2),
    "utf8"
  );

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

export function safeFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

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

function timestampForPath(date: Date): string {
  return date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/, "");
}
