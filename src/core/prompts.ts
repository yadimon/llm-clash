// ---------------------------------------------------------------------------
// Prompt builders for every phase of the multi-draft refinement pipeline.
//
// All prompts are plain strings (no system messages, no role hierarchy) so
// they work uniformly across chat completion APIs, completion-only APIs,
// and CLI-based adapters that just take text on stdin.
//
// The output FORMAT in each prompt is contractual: `parser.ts` looks for
// the headers `# Improved Answer`, `# Changes Made`, `## Candidate N`,
// `# Best Candidate`, `# Reason`, and the per-criterion `Label: X/10` lines.
// If you change the format here, update the parser regexes too.
// ---------------------------------------------------------------------------

import type { BuiltInEvaluationCriterion, Draft, EvaluationCriterion } from "./types.js";

/**
 * Human-readable label for each built-in criterion, used inside prompts and
 * in the parser to recognize score lines like "Goal Fit: 7/10".
 */
const CRITERION_LABELS: Record<BuiltInEvaluationCriterion, string> = {
  accuracy: "Accuracy",
  completeness: "Completeness",
  usefulness: "Usefulness",
  clarity: "Clarity",
  goal_fit: "Goal Fit",
  specificity: "Specificity",
  risk_control: "Risk Control"
};

/**
 * Per-criterion guidance shown to judges so they score consistently across
 * runs and across different judge models. Keep these short — verbose
 * descriptions tend to push judges into over-explaining instead of scoring.
 */
const CRITERION_DESCRIPTIONS: Record<BuiltInEvaluationCriterion, string> = {
  accuracy: "Correctness, logical consistency, absence of factual or reasoning errors.",
  completeness: "How fully the answer covers the task.",
  usefulness: "How practical and helpful the answer is for the user.",
  clarity: "Structure, readability, lack of confusion.",
  goal_fit: "How well the answer matches the actual user goal.",
  specificity: "Concrete detail, examples, and implementation-ready guidance.",
  risk_control: "How well the answer identifies uncertainty, risks, and safeguards."
};

/**
 * Public lookup so the parser can match score lines against the same labels.
 *
 * Built-in criteria use the curated labels above. Custom criteria get a
 * deterministic generated label: the id is split on `_`/`-` and each word is
 * capitalized (`guardrail_quality` → "Guardrail Quality"). Judge prompts and
 * the response parser both go through this function, so custom criteria are
 * matched end-to-end with the same label.
 */
export function criterionLabel(criterion: EvaluationCriterion): string {
  return CRITERION_LABELS[criterion as BuiltInEvaluationCriterion] ?? humanizeCriterion(criterion);
}

/** Judge guidance for a criterion; custom criteria get a neutral fallback. */
function criterionDescription(criterion: EvaluationCriterion): string {
  return (
    CRITERION_DESCRIPTIONS[criterion as BuiltInEvaluationCriterion] ??
    "Judge this criterion by its name."
  );
}

/** `guardrail_quality` / `guardrail-quality` → "Guardrail Quality". */
function humanizeCriterion(criterion: string): string {
  return criterion
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Round-0 prompt — the model has no peer drafts yet, just the task.
 *
 * Deliberately avoids over-prescribing the answer style (no required output
 * format) so each model can play to its strengths during the initial draft.
 */
export function initialPrompt(task: string): string {
  return `You need to produce the best possible answer for the task below.

Task:
${task}

Requirements:
- Be accurate, complete, and useful.
- Prefer quality over brevity.
- Make the answer well-structured.
- Avoid unsupported claims.
- If something is uncertain, state it clearly.
- Do not include meta commentary about being a model.

Produce the answer.`;
}

/**
 * Refinement prompt — shown to a model that already has a draft and needs to
 * improve it after seeing the other models' drafts.
 *
 * Key design decisions:
 * - The model sees its OWN previous draft AND the other variants.
 * - It is explicitly told the variants may be wrong, so it should not
 *   blindly merge them. This counteracts the strong "be helpful and
 *   incorporate everything" bias most chat models have.
 * - The required output format (`# Improved Answer` + `# Changes Made`) is
 *   what `extractImprovedAnswer` parses; keep them in sync.
 */
export function refinementPrompt(task: string, ownDraft: Draft, otherDrafts: Draft[]): string {
  return `You previously created an answer for the task below.

Task:
${task}

Your current answer:
${ownDraft.text}

Additional answer variants:
${formatDraftVariants(otherDrafts)}

Your task:
Create an improved version of your current answer.

Rules:
- Treat the additional variants as potentially useful but not automatically correct.
- They may contain useful ideas, omissions, mistakes, weak reasoning, or unsupported claims.
- Do not copy or concatenate them mechanically.
- Compare them against the original task and your current answer.
- If an additional variant contains a useful idea, include it only if it genuinely improves the result.
- If an additional variant contains a questionable or unsupported point, ignore it or handle it carefully.
- If variants contradict each other, resolve the contradiction using the original task and reasoning.
- Keep the result focused on the user's task.
- Prefer correctness, completeness, usefulness, and clarity over brevity.
- The final answer should be better than your current answer.

Output format:

# Improved Answer

{{your improved answer}}

# Changes Made

Briefly explain what you improved and why.`;
}

/**
 * Evaluation prompt — turns a model into a judge that scores every final
 * draft against the active criteria.
 *
 * The output template is reproduced verbatim in the prompt (with the right
 * criterion labels and N candidates) so judges have an explicit form to
 * fill in. `parser.ts` then walks that form to extract structured scores.
 *
 * Run with `temperature: 0` (set by the orchestrator) for stable scoring.
 */
export function evaluationPrompt(
  task: string,
  candidates: Draft[],
  criteria: EvaluationCriterion[]
): string {
  // Build the numbered criterion list shown in the prompt body.
  const criteriaText = criteria
    .map((criterion, index) => {
      return `${index + 1}. ${criterionLabel(criterion)}
   ${criterionDescription(criterion)}`;
    })
    .join("\n\n");

  return `Evaluate several candidate answers for the same task.

Task:
${task}

Candidate answers:
${formatCandidates(candidates)}

Evaluation criteria:

${criteriaText}

Score each candidate from 0 to 10 for every criterion.

Then provide:
- total score
- best candidate
- short explanation
- whether the difference between the top candidates is significant

Output format:

# Evaluation

## Candidate 1
${criteria.map((criterion) => `${criterionLabel(criterion)}: X/10`).join("\n")}
Total: X/10

Strengths:
- ...

Weaknesses:
- ...

## Candidate 2
...

# Best Candidate

Candidate N

# Reason

...`;
}

/**
 * Synthesis prompt — used in `synthesize` and `choose_or_synthesize` modes
 * to fuse the best parts of all final drafts into one canonical answer.
 *
 * The judges' aggregated scores are passed in as `evaluationSummary` so the
 * synthesizer knows which drafts were considered strongest and on which
 * criteria — without that context it tends to give every candidate equal
 * weight, which produces bland mash-ups.
 */
export function synthesisPrompt(
  task: string,
  candidates: Draft[],
  evaluationSummary: string
): string {
  return `You need to create one final answer from several strong candidate answers.

Task:
${task}

Candidate answers:
${formatCandidates(candidates)}

Evaluation summary:
${evaluationSummary}

Your task:
Create the best final answer.

Rules:
- Do not simply concatenate candidates.
- Preserve the strongest parts.
- Remove repetitions.
- Resolve contradictions.
- Do not include unsupported claims.
- Prefer a result that is accurate, complete, useful, clear, and aligned with the task.
- If something remains uncertain, state it clearly.

Produce only the final answer.`;
}

/**
 * Format the OTHER drafts shown to a model during a refinement round.
 *
 * Drafts are anonymized as "Variant 1", "Variant 2", … (no model ids) so
 * the model judges the WRITING and not the brand of the model that wrote it.
 */
function formatDraftVariants(drafts: Draft[]): string {
  if (drafts.length === 0) {
    return "No additional variants were provided.";
  }

  return drafts
    .map((draft, index) => {
      return `Variant ${index + 1}:
${draft.text}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Format candidates for the evaluation/synthesis prompts.
 *
 * Same anonymization rationale as `formatDraftVariants`: judges see
 * "Candidate 1..N" instead of model ids so they grade the answers, not the
 * provenance.
 */
function formatCandidates(candidates: Draft[]): string {
  return candidates
    .map((candidate, index) => {
      return `Candidate ${index + 1}:
${candidate.text}`;
    })
    .join("\n\n---\n\n");
}
