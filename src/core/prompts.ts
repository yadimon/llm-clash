import type { Draft, EvaluationCriterion } from "./types.js";

const CRITERION_LABELS: Record<EvaluationCriterion, string> = {
  accuracy: "Accuracy",
  completeness: "Completeness",
  usefulness: "Usefulness",
  clarity: "Clarity",
  goal_fit: "Goal Fit",
  specificity: "Specificity",
  risk_control: "Risk Control"
};

const CRITERION_DESCRIPTIONS: Record<EvaluationCriterion, string> = {
  accuracy: "Correctness, logical consistency, absence of factual or reasoning errors.",
  completeness: "How fully the answer covers the task.",
  usefulness: "How practical and helpful the answer is for the user.",
  clarity: "Structure, readability, lack of confusion.",
  goal_fit: "How well the answer matches the actual user goal.",
  specificity: "Concrete detail, examples, and implementation-ready guidance.",
  risk_control: "How well the answer identifies uncertainty, risks, and safeguards."
};

export function criterionLabel(criterion: EvaluationCriterion): string {
  return CRITERION_LABELS[criterion];
}

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

export function evaluationPrompt(
  task: string,
  candidates: Draft[],
  criteria: EvaluationCriterion[]
): string {
  const criteriaText = criteria
    .map((criterion, index) => {
      return `${index + 1}. ${criterionLabel(criterion)}
   ${CRITERION_DESCRIPTIONS[criterion]}`;
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

function formatCandidates(candidates: Draft[]): string {
  return candidates
    .map((candidate, index) => {
      return `Candidate ${index + 1}:
${candidate.text}`;
    })
    .join("\n\n---\n\n");
}
