// ---------------------------------------------------------------------------
// Public package entrypoint.
//
// What's re-exported here is the entire SDK surface — adapters, the
// orchestrator function, the parser/scoring helpers, and every shared type.
// The CLI in `./cli/run.ts` is its own bin (see `package.json` "bin"
// field) and is NOT exported from this module.
//
// Adapter sub-paths (declared in package.json `exports`) let consumers
// tree-shake unused providers, e.g.:
//
//   import { vercelAi } from "@yadimon/llm-clash/adapters/vercel-ai";
//   import { runMultiDraftRefinement } from "@yadimon/llm-clash";
// ---------------------------------------------------------------------------

// --- Adapters --------------------------------------------------------------
// Each adapter wraps one model provider (HTTP API, sub-process, or in-process
// mock) and conforms to the `ModelAdapter` interface from `./core/types.js`.
export { commandAdapter } from "./adapters/commandAdapter.js";
export type { CommandAdapterConfig } from "./adapters/commandAdapter.js";
export { anthropic } from "./adapters/anthropic.js";
export type { AnthropicAdapterConfig } from "./adapters/anthropic.js";
export { mockAdapter } from "./adapters/mock.js";
export type { MockAdapterConfig } from "./adapters/mock.js";
export { openaiCompatible } from "./adapters/openaiCompatible.js";
export type { OpenAICompatibleAdapterConfig } from "./adapters/openaiCompatible.js";
export { vercelAi } from "./adapters/vercelAi.js";
export type {
  VercelAiAdapterConfig,
  VercelAiGenerateText,
  VercelAiUsage
} from "./adapters/vercelAi.js";

// --- Orchestrator ----------------------------------------------------------
// The single function most users call to run the full pipeline.
export { runMultiDraftRefinement } from "./core/orchestrator.js";

// --- Parser helpers --------------------------------------------------------
// Exposed so advanced users can reuse the same heuristic markdown parser
// the orchestrator uses internally — useful for offline post-processing of
// archived run artifacts.
export {
  extractImprovedAnswer,
  parseBestCandidate,
  parseCandidateBlock,
  parseEvaluationText,
  parseStrengthsWeaknesses,
  splitCandidateBlocks
} from "./core/parser.js";

// --- Prompt builders -------------------------------------------------------
// Exposed so consumers can replicate one phase of the pipeline (e.g. just
// the synthesis step) without going through the orchestrator.
export {
  initialPrompt,
  refinementPrompt,
  evaluationPrompt,
  synthesisPrompt
} from "./core/prompts.js";

// --- Scoring helpers -------------------------------------------------------
// Direct access to the cross-judge aggregation algorithm.
export { aggregateEvaluations } from "./core/scoring.js";

// --- Shared types ----------------------------------------------------------
// Every type the public API surfaces or accepts. See `./core/types.js` for
// the per-type documentation.
export type {
  AggregatedEvaluation,
  BuiltInEvaluationCriterion,
  CandidateScore,
  Draft,
  EvaluationCriterion,
  EvaluationResult,
  FinalMode,
  ModelAdapter,
  ModelInput,
  ModelOutput,
  RoundResult,
  RunConfig,
  RunEvent,
  RunResult
} from "./core/types.js";
