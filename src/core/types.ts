export type EvaluationCriterion =
  | "accuracy"
  | "completeness"
  | "usefulness"
  | "clarity"
  | "goal_fit"
  | "specificity"
  | "risk_control";

export type FinalMode = "choose_best" | "synthesize" | "choose_or_synthesize";

export type ModelInput = {
  prompt: string;
  system?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type ModelOutput = {
  text: string;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  raw?: unknown;
};

export interface ModelAdapter {
  id: string;
  label?: string | undefined;
  generate(input: ModelInput): Promise<ModelOutput>;
}

export type Draft = {
  id: string;
  modelId: string;
  round: number;
  text: string;
  notes?: string | undefined;
  createdAt: string;
};

export type RoundResult = {
  round: number;
  drafts: Draft[];
};

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

export type CandidateScore = {
  candidateId: string;
  modelId?: string | undefined;
  scores: Partial<Record<EvaluationCriterion, number>>;
  total: number;
  strengths?: string[] | undefined;
  weaknesses?: string[] | undefined;
  explanation?: string | undefined;
};

export type EvaluationResult = {
  judgeModelId: string;
  text: string;
  candidateScores: CandidateScore[];
  bestCandidateId?: string | undefined;
  reason?: string | undefined;
};

export type AggregatedCandidate = {
  candidateId: string;
  modelId: string;
  scores: Partial<Record<EvaluationCriterion, number>>;
  weightedTotal: number;
};

export type AggregatedEvaluation = {
  candidates: AggregatedCandidate[];
  winner?: string | undefined;
  tie: boolean;
  significantDifference: boolean;
};

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

export type RunEvent =
  | { type: "round_start"; round: number }
  | { type: "draft_created"; draft: Draft }
  | { type: "round_complete"; round: number; drafts: Draft[] }
  | { type: "evaluation_start"; judgeModelId: string }
  | { type: "evaluation_complete"; result: EvaluationResult }
  | { type: "synthesis_start" }
  | { type: "artifacts_saved"; outputDir: string }
  | { type: "run_complete"; winner?: string | undefined };

export const DEFAULT_EVALUATION_CRITERIA: EvaluationCriterion[] = [
  "accuracy",
  "completeness",
  "usefulness",
  "clarity",
  "goal_fit"
];
